/**
 * Policies — **the AI seam**.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" ("the standing
 * rule that **the AI is a replaceable `Policy`, never hard-wired into the engine**
 * — M7's self-play needs to swap strategies, and balance work needs to run the same
 * seed under different ones").
 *
 * ## The seam
 *
 * `Policy` (declared in `./types.ts`, `chooseCommands(ctx) => readonly Command[]`)
 * is the *only* way a decision enters a game. The engine knows nothing about these
 * two policies: `runner.ts` resolves a policy per civilization by player id, hands
 * it the state, a player id, the ruleset and **its own RNG stream**, and applies
 * whatever comes back through `applyCommand`. Nothing in this package branches on
 * `policy.name`, and nothing may: an engine that recognised a policy would be an
 * engine with an AI inside it, and a balance sweep could no longer compare
 * strategies on one seed.
 *
 * So a policy is a *pure function from a state to commands*:
 *
 * - it never mutates the state it was given;
 * - it never draws from `state.rng` (that is the world's stream — see `runner.ts`);
 * - it uses only `ctx.rng` when it wants randomness, which is its own stream, so two
 *   policies can be compared on the same seed and swapping one cannot move the
 *   world's randomness;
 * - and it is deterministic in `(state, playerId, ruleset, rng)`: two calls on the
 *   same arguments return the same commands.
 *
 * ## The two shipped policies are PLACEHOLDERS for M7's real AI
 *
 * **Nothing here is a strategy, a claim about Civ 3, or a tuned opponent.** They
 * exist so that the simulation loop has something to run at both ends of the dial:
 *
 * - `DO_NOTHING_POLICY` — the **baseline**: it commands nothing at all. It is the
 *   control a balance sweep compares against (the same seed, the same world, no
 *   decisions: whatever moves in the metrics is the world's doing, not the AI's),
 *   and with it a run reports `stoppedBecause: 'no-commands'`.
 * - `SIMPLE_POLICY` — the **genuine but crude** one: it founds cities with its
 *   settlers, walks units toward unexplored ground and toward tiles worth working,
 *   puts idle workers on a job, and keeps every city's production and worked-tile
 *   assignment sensible. "Sensible" is the whole ambition; there is no search, no
 *   lookahead, no opponent model, and no combat logic that M6 will need.
 *
 * Both are **unsourced heuristics** — their thresholds are not Civ 3's, and they are
 * not measured against anything. The few numbers either of them carries live in
 * `SIMPLE_POLICY_TUNING`, in one named value, so a sweep can vary them without
 * editing logic (the standing requirement's "Tunable"), and they are documented
 * there as placeholders.
 *
 * ## How the simple policy decides, in one paragraph
 *
 * Cities first, then units. A city that is building nothing (or something the
 * ruleset no longer allows) is set to the item its own `cityProductionOptions`
 * offers in a fixed priority — settler while it has fewer than `targetCities`,
 * then worker, then military, then the cheapest building — and a city whose worked
 * tiles are not the best ones the engine would assign is re-assigned through
 * `autoAssignWorkedTiles`, the engine's own "which tiles are best" rule. A settler
 * that may found does (`planFoundCity` is the gate); a worker that is idle takes a
 * job `unitActions` offers on its own tile and a worker already working is left
 * alone (a step would cancel the job); anything else steps toward the best ground
 * it can reach, scored as an integer tuple.
 *
 * **M6 adds combat, after research and before a unit moves.** A unit that can make a
 * *profitable* attack makes it, a military unit in contact with an enemy that cannot
 * attacks nothing and **fortifies** instead, and anything else falls through to the
 * movement it did before. "Profitable" is not this file's opinion: the attack's odds are
 * the `attackerWinPct` on the `CombatResolved` line the **applier itself** reports when
 * the attack is folded on a scratch copy of the state, and the threshold that turns those
 * odds into a decision is `attackOddsFloorPct`, one placeholder number in
 * `SIMPLE_POLICY_TUNING`. A **capture** — an undefended enemy city — is always taken:
 * there is no battle to lose, so there are no odds to weigh. See the section comment
 * above `bestAttack` for why the policy reads the odds rather than the result, and for
 * what "avoid" is and is not taken to mean here.
 *
 * **M5 adds research, between the two.** Once per turn the policy picks the tech its
 * own ranking prefers among the ones `researchProblem` calls legal and issues one
 * `SetResearch` — so a simulated game actually walks the tech tree instead of banking
 * beakers for ever, which is what makes a research cost knob *measurable* in the
 * balance harness rather than a number nothing reads. The rule is
 * `chooseResearch`'s and it is not restated here; what matters at this level is that
 * the choice is deterministic, reads no randomness, and prefers a tech that unlocks
 * something this AI is actually trying to build. It is, like everything else in this
 * file, a **placeholder for M7's real AI**: there is no lookahead, no era planning and
 * no evaluation of whether the tech is *reachable* in the turns a game has left.
 *
 * ## The policy is a function of the CONTENT, never of the catalog's ROW ORDER
 *
 * Every choice this file makes among several candidates — a unit of a role, a
 * building, a worker's job, a step — is decided by a **total order stated beside it**:
 * an item's price and then its `(kind, id)`; the kind of the row a `StartWork` names
 * (ranked by the engine's own `IMPROVEMENT_KINDS` vocabulary, see `compareJobs`) and
 * then that row's id; a step's rank and then its tile index. Every one of those is a
 * value of the candidate itself. No choice is "the first one the ruleset happened to
 * list", because a row's *position* is not part of what a ruleset means: the same
 * ruleset rows in another order are the same ruleset, and M11's save/replay has to
 * mean "the same game" across an editorial reorder of the catalog. `policies.test.ts`
 * proves it by replaying three seeds with the rows reversed and with them shuffled,
 * and it pins what is still order-dependent *beneath* this policy — two engine rules
 * that read row order, reported rather than compensated for here (see the note at the
 * end of that file).
 *
 * **The policy plans by asking the engine.** Every candidate is folded through the
 * same `applyCommand` the runner will use, on a *local* copy of the state that the
 * policy then discards. That is what makes its proposals legal by construction
 * rather than by hope — the alternative is a policy that believes a tile is free
 * and is told otherwise by the applier — and it is a preview, not a mutation: the
 * runner still owns the only real state, and the commands it receives are the same
 * commands, in the same order, that the local fold applied.
 */

import {
  IMPROVEMENT_KINDS,
  applyCommand,
  autoAssignWorkedTiles,
  citiesOf,
  cityAt,
  cityProductionOptions,
  inBounds,
  indexToX,
  indexToY,
  isExplored,
  isFortified,
  itemCost,
  improvementDef,
  knownTechs,
  neighbors8,
  planFoundCity,
  researchProblem,
  researchingOf,
  techCatalog,
  techCostOf,
  techUnlocks,
  tileIndex,
  tileYieldsWithResources,
  unitActions,
  unitById,
  unitCatalog,
  unitDef,
  unitsOnTile,
  VISIBILITY_RADIUS,
  type City,
  type Command,
  type GameEvent,
  type GameState,
  type ImprovementId,
  type PlayerId,
  type ProductionItem,
  type RulesetView,
  type TechId,
  type TileIndex,
  type Unit,
  type UnitId,
  type UnitRole,
} from '@civts/core';

import type { Policy, PolicyContext } from './types.js';

/* ------------------------------------------------------------------ *
 * The policy's own numbers — heuristics, not rules
 * ------------------------------------------------------------------ */

/**
 * The simple policy's thresholds.
 *
 * **Every value here is a placeholder heuristic: unsourced, chosen to be playable,
 * and not a Civ 3 figure.** They are policy taste, not game rules — no catalog row
 * can hold them, because they say how *this* AI plays rather than what the world
 * permits — and they are collected in one value for the reason the standing
 * requirement gives: a number a sweep might vary should never be a literal buried in
 * a branch. `simplePolicy(tuning)` is how a sweep varies them.
 *
 * - `targetCities` — how many cities this AI settles before its cities build
 *   something else.
 * - `workersPerCity` — how many workers it wants per city.
 * - `defendersPerCity` — how many military units it wants per city.
 */
export interface SimplePolicyTuning {
  readonly targetCities: number;
  readonly workersPerCity: number;
  readonly defendersPerCity: number;
  /**
   * The per-round odds (the applier's own `attackerWinPct`, in whole percent) at which
   * this AI is willing to start a battle. **PLACEHOLDER: unsourced, chosen to be
   * playable, not a Civ 3 figure and not a measured optimum.**
   *
   * It is a threshold on the *per-round* number the engine reports, not on the battle's
   * overall probability, and that is a deliberate simplification: working out the
   * battle's own probability means restating the resolver's race (how many rounds each
   * side survives, and that ties go to the defender), which would be a second statement
   * of `combat.ts`' rule and would drift from it. At `50` the attacker is at least as
   * likely to win a round as to lose one, which is the crudest honest reading of
   * "profitable"; a sweep varies it (`scripts/combat-balance-sweep.ts`).
   */
  readonly attackOddsFloorPct: number;
}

/** The defaults `simplePolicy` uses when a caller overrides nothing. PLACEHOLDER. */
export const SIMPLE_POLICY_TUNING: SimplePolicyTuning = {
  targetCities: 4,
  workersPerCity: 1,
  defendersPerCity: 1,
  attackOddsFloorPct: 50,
};

/**
 * A guard on this policy's own step loop, **not a rule of the game**.
 *
 * The real bound is the unit's own movement budget: in a validated ruleset every
 * terrain costs at least one point to enter, so "step while it has movement left"
 * terminates by itself. A *foreign* or hand-built ruleset can carry a zero-cost
 * terrain, and then a policy that only asked "can it still move?" would walk one
 * unit for ever — a hung simulation is a worse failure than a bounded one, which is
 * the same reading `MAX_GROWTHS_PER_TURN` takes in `invariants.ts`. This cap is
 * therefore about *this loop*, and the effective cap is the smaller of it and the
 * unit's own movement.
 */
const MAX_STEPS_PER_UNIT = 8;

/* ------------------------------------------------------------------ *
 * Reading the board
 * ------------------------------------------------------------------ */

/** A rank as a tuple of integers, compared left to right (`compareRanks`). */
type Rank = readonly number[];

/**
 * Compare two ranks lexicographically, largest first.
 *
 * Ranks are integer tuples because the alternative is a weighted sum, and a weight
 * is a magnitude nobody can justify: "one shield is worth 1.5 food" is a claim this
 * policy has no basis for. A tuple says "this comes first, then that", which is the
 * honest form of the same opinion, and it keeps every comparison in integer
 * arithmetic.
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

/**
 * Compare two strings by UTF-16 code unit, ascending — the tie-break under every
 * content choice this file makes.
 *
 * Code units rather than `localeCompare`, because a collation is locale state: it
 * would make the AI's play depend on the environment, which is precisely what a
 * deterministic harness forbids (`harness-adversarial.test.ts` varies `LANG` for
 * that reason). Ids are opaque strings chosen by content — this only has to be a
 * *total* order over them, and code units are one on every machine.
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A ranker: what the policy thinks of standing on `tile`, in the given state. */
type Ranker = (state: GameState, tile: TileIndex) => Rank;

/** What a tile is worth in this state: terrain, improvements and bonus resources. */
const yieldsAt = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): { readonly food: number; readonly shields: number; readonly commerce: number } =>
  tileYieldsWithResources(state, ruleset, tile) ?? { food: 0, shields: 0, commerce: 0 };

/** 1 when a goody hut sits on `tile`, else 0 — a step onto one is a reward to claim. */
const hutAt = (state: GameState, tile: TileIndex): number =>
  state.map.huts.some((hut) => Number(hut) === Number(tile)) ? 1 : 0;

/**
 * How much of the map a unit standing on `tile` would see that this player has never
 * seen: the count of unexplored tiles inside the visibility box.
 *
 * The box is the engine's own sight rule, not a re-statement of it: its half-width is
 * `VISIBILITY_RADIUS` (the constant `fog.ts` uses to decide what a unit sees), and
 * whether a tile is explored is `isExplored`. What this function adds is only the
 * *hypothetical* — "what would be revealed from there?" — which `visibleTiles` cannot
 * answer, because it derives sight from where units already stand.
 */
const revealCount = (state: GameState, playerId: PlayerId, tile: TileIndex): number => {
  let count = 0;
  for (const candidate of neighbourhood(state, tile)) {
    if (!isExplored(state, playerId, candidate)) count += 1;
  }
  return count;
};

/**
 * Every tile of the visibility box around `tile`, clipped to the map, ascending by
 * index (row-major: the loop is `dy` then `dx`, so the order is a property of the
 * loop and not of a comparison).
 *
 * The box is what a unit standing there would see, which is why the two rankers below
 * — "how much would this reveal" and "how close is a legal city site" — are both
 * measured over it.
 */
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

/** `state` with `unitId` placed on `tile`: rebuilt, never mutated, and thrown away. */
const withUnitAt = (state: GameState, unitId: UnitId, tile: TileIndex): GameState => ({
  ...state,
  units: state.units.map((unit) => (unit.id === unitId ? { ...unit, tile } : unit)),
});

/**
 * Would a city founded by `unitId` be legal if the unit stood on `tile`?
 *
 * Asked of the engine's **own planner** — `planFoundCity`, the evaluator
 * `applyCommand` refuses with — on a hypothetical state. That is what keeps "a good
 * city site" from becoming a second, drifting copy of the founding rule (terrain
 * role, land, `MIN_CITY_DISTANCE` against every existing city): this policy asks the
 * same question the applier will, one tile early.
 */
const canFoundAt = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
  tile: TileIndex,
): boolean => planFoundCity(withUnitAt(state, unitId, tile), ruleset, playerId, unitId).ok;

/**
 * How many tiles a settler standing on `tile` could see that are legal city sites.
 *
 * This is the settler's *gradient*. Without it a produced settler has nowhere to go:
 * it is placed on or beside its own city, where founding is illegal (`MIN_CITY_DISTANCE`),
 * and a rank made only of terrain has no reason to prefer any particular direction —
 * so the settler would stand still and the civilization would never grow past one
 * city, piling up settlers it cannot use. Counting legal sites inside the visibility
 * box is the cheapest honest form of "walk toward where a city could go": it is 0
 * everywhere the settler cannot build and rises as legal ground comes into view.
 */
const legalSiteCount = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
  tile: TileIndex,
): number => {
  let count = 0;
  for (const candidate of neighbourhood(state, tile)) {
    if (canFoundAt(state, ruleset, playerId, unitId, candidate)) count += 1;
  }
  return count;
};

/**
 * The exploration rank: **claim a hut, then see more, then stand on better ground**.
 *
 * This is the whole of "moves units toward unexplored or useful tiles" for everything
 * that is not a settler: a hut is a reward to claim, the tile beyond the fog is where
 * the next decision comes from, and a slightly better tile breaks the tie. Ties are
 * broken by the lowest tile index (in `bestStep`), so the choice is a function of the
 * state alone — no RNG is needed to make this policy deterministic, which is why it is
 * a good control for "changing the policy changes only the game".
 */
const exploreRanker =
  (ruleset: RulesetView, playerId: PlayerId): Ranker =>
  (state, tile) => {
    const yields = yieldsAt(state, ruleset, tile);
    return [
      hutAt(state, tile),
      revealCount(state, playerId, tile),
      yields.food,
      yields.shields,
      yields.commerce,
    ];
  };

/**
 * The settlement rank: **stand where a city may be founded, then near legal ground,
 * then on better terrain**.
 *
 * The first two entries are the difference between a settler and an explorer — a
 * settler's job is a site, not a view — and they are what makes the policy actually
 * grow a civilization: a settler produced by a city is standing where founding is
 * illegal, and this rank is what walks it out to the nearest place a city may go
 * (`canFoundAt` / `legalSiteCount`, both asked of the engine's own planner).
 */
const settleRanker =
  (ruleset: RulesetView, playerId: PlayerId, unitId: UnitId): Ranker =>
  (state, tile) => {
    const yields = yieldsAt(state, ruleset, tile);
    return [
      canFoundAt(state, ruleset, playerId, unitId, tile) ? 1 : 0,
      legalSiteCount(state, ruleset, playerId, unitId, tile),
      yields.food,
      yields.shields,
      yields.commerce,
    ];
  };

/* ------------------------------------------------------------------ *
 * Command narrowing
 * ------------------------------------------------------------------ */

type MoveCommand = Extract<Command, { readonly type: 'MoveUnit' }>;
type StartWorkCommand = Extract<Command, { readonly type: 'StartWork' }>;

const isMove = (command: Command): command is MoveCommand => command.type === 'MoveUnit';
const isStartWork = (command: Command): command is StartWorkCommand => command.type === 'StartWork';

/**
 * The engine's improvement vocabulary as this file's job ranking: `road`, `mine`,
 * `irrigation` (`IMPROVEMENT_KINDS`).
 *
 * A *vocabulary*, not a catalog: it is a constant of `@civts/core`, the same three
 * words on every ruleset, and no ruleset can reorder it — which is exactly why it
 * can rank a candidate without the answer depending on where the candidate's row
 * sits. (`improvements.ts` uses the same list for the same kind of reason, to give a
 * tile's `(tile, kind)` pairs one stored order.) A row whose kind is outside the list
 * ranks `-1`, before everything: arbitrary but total, the reading `improvements.ts`
 * takes for its own sort.
 */
const JOB_KIND_ORDER: readonly string[] = IMPROVEMENT_KINDS;

/**
 * Where a job's *kind* sorts in the engine's vocabulary.
 *
 * The command says `kind` but carries an improvement **id** (`StartWork` names the
 * row a worker builds, and `actions.ts` enumerates one per catalog id), so the row
 * has to be looked up to read its kind: the vocabulary is the engine's, the id is
 * content's, and only the row ties the two together. An id the ruleset does not
 * describe ranks `-1` — a kind that cannot be read ranks before every kind that can,
 * which is arbitrary and total.
 */
const jobKindRank = (ruleset: RulesetView, id: ImprovementId): number => {
  const kind = improvementDef(ruleset, id)?.kind;
  return kind === undefined ? -1 : JOB_KIND_ORDER.indexOf(kind);
};

/**
 * The canonical order over a worker's jobs: **the rank of the kind the job builds,
 * then the id naming it** — content's own values, read off the candidate, never the
 * position of the row that offered it.
 *
 * This is the rule that decides which job an idle worker starts. Its predecessor was
 * `unitActions(...).find(isStartWork)`, and `unitActions` lists one `StartWork` per
 * catalog kind *in catalog order*, so "the first job offered" was a decision taken
 * from the improvements array's positions: reorder that array and the worker builds a
 * different thing. Two candidates of the *same* kind are separated by the tie-break
 * alone — content is free to ship two rows of one kind (a road and a highway), so the
 * kind rank is not total on its own, and the id makes it so.
 */
const compareJobs = (ruleset: RulesetView, a: StartWorkCommand, b: StartWorkCommand): number => {
  const byKind = jobKindRank(ruleset, a.kind) - jobKindRank(ruleset, b.kind);
  return byKind !== 0 ? byKind : compareText(String(a.kind), String(b.kind));
};

/**
 * The job this policy puts an idle worker on: the `StartWork` action that comes
 * first in `compareJobs`' canonical order, or `undefined` when the engine offers
 * none. Never "the first one the list happened to hold".
 */
const chooseJob = (
  actions: readonly Command[],
  ruleset: RulesetView,
): StartWorkCommand | undefined => {
  let best: StartWorkCommand | undefined;
  for (const action of actions) {
    if (!isStartWork(action)) continue;
    if (best === undefined || compareJobs(ruleset, action, best) < 0) best = action;
  }
  return best;
};

/**
 * The best legal step for `unit`, or `undefined` when every step is worse than
 * standing still.
 *
 * Candidates come from `unitActions` — the engine's own enumeration, so every one of
 * them is a move the applier accepts — and the comparison is a strict improvement of
 * the rank, which is what stops a unit from pacing between two equally good tiles.
 * Ties are broken by the lowest tile index, so the decision never depends on the
 * order the engine happened to enumerate in.
 */
const bestStep = (
  state: GameState,
  ruleset: RulesetView,
  unit: Unit,
  rank: Ranker,
): MoveCommand | undefined => {
  const here = rank(state, unit.tile);
  let best:
    { readonly command: MoveCommand; readonly rank: Rank; readonly tile: number } | undefined;

  for (const move of unitActions(state, ruleset, unit.id).filter(isMove)) {
    const score = rank(state, move.to);
    if (compareRanks(score, here) <= 0) continue;
    if (best === undefined) {
      best = { command: move, rank: score, tile: Number(move.to) };
      continue;
    }
    const better = compareRanks(score, best.rank);
    if (better > 0 || (better === 0 && Number(move.to) < best.tile)) {
      best = { command: move, rank: score, tile: Number(move.to) };
    }
  }

  return best?.command;
};

/* ------------------------------------------------------------------ *
 * Cities
 * ------------------------------------------------------------------ */

/** The unit role a production item builds, or `undefined` for a building. */
const roleOfItem = (ruleset: RulesetView, item: ProductionItem): UnitRole | undefined =>
  item.kind === 'unit' ? unitDef(ruleset, item.id)?.role : undefined;

/** How many units of `role` the player owns. */
const countRole = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  role: UnitRole,
): number =>
  state.units.filter(
    (unit) => unit.owner === playerId && unitDef(ruleset, unit.type)?.role === role,
  ).length;

/**
 * The canonical order over production items: **kind, then id**, both by code unit.
 *
 * This is the one tie-break every "which item?" decision in this file uses, and the
 * reason it exists is that a catalog's row order is not part of what the catalog
 * says. `cityProductionOptions` lists units before buildings and each of those in
 * catalog order (that order is the *engine's* answer, and the UI wants it), so
 * "the first item of a role" or "the first building" is a decision taken from an
 * array's *positions*; ranking by the item's own `(kind, id)` is the same decision
 * taken from its *content*, and it is total — two distinct items always compare, so
 * there is no residual "keep whichever came first" branch that could inherit row
 * order.
 */
const compareItems = (a: ProductionItem, b: ProductionItem): number => {
  const byKind = compareText(a.kind, b.kind);
  return byKind !== 0 ? byKind : compareText(String(a.id), String(b.id));
};

/**
 * The cheapest item, ties broken by the canonical item order (`compareItems`).
 *
 * "Cheapest" is `itemCost` — the engine's own price, the same one production charges
 * — so this cannot drift from what the city will actually pay. The tie-break is what
 * makes the choice independent of catalog order, which matters because catalog
 * order is content order and a reordered catalog must not silently change a
 * simulation's outcome; it is total (`compareItems` never returns 0 for two
 * distinct items), so the answer cannot fall back to input order.
 */
const cheapest = (
  options: readonly ProductionItem[],
  ruleset: RulesetView,
): ProductionItem | undefined => {
  let best: ProductionItem | undefined;
  for (const item of options) {
    if (best === undefined) {
      best = item;
      continue;
    }
    const cost = itemCost(ruleset, item);
    const bestCost = itemCost(ruleset, best);
    if (cost < bestCost || (cost === bestCost && compareItems(item, best) < 0)) best = item;
  }
  return best;
};

/**
 * The item this policy builds to get a unit of `role`: **the cheapest offered item
 * that builds one, ties broken by the canonical item order** — `cheapest` applied to
 * that role's own candidates, so this file has exactly one ordering rule and it
 * reads content, never row positions.
 *
 * It replaced a `firstOfRole` that took the first role match off
 * `cityProductionOptions`, and the difference is not cosmetic: that function's
 * answer was a function of the units catalog's row order. Reversing the shipped
 * `units` array moves its first `military` row from the warrior (cost 1, land) to
 * the swordsman (cost 3, gated on a connected iron) and then to the galley (cost 2,
 * **sea**) — and the AI is handed whatever the row order says, which on a land map
 * produced an armada of galleys no warrior could defend. On the shipped catalog the
 * cheapest military row *is* the warrior, so this rule and the row order agree
 * here; where they disagree, this one is the answer that is a function of the
 * content alone.
 */
const cheapestOfRole = (
  options: readonly ProductionItem[],
  ruleset: RulesetView,
  role: UnitRole,
): ProductionItem | undefined =>
  cheapest(
    options.filter((item) => roleOfItem(ruleset, item) === role),
    ruleset,
  );

/**
 * What `city` should build next, or `undefined` to leave its queue alone.
 *
 * The options are `cityProductionOptions` — the engine's own answer to "what may this
 * city legally be set to build", resource gates and wonders included — so this
 * function chooses *among legal items* and never has to know why one is missing. A
 * city already building something still on the list is left alone: a placeholder AI
 * has no reason to cancel a project every turn, and the engine drops a head that
 * becomes illegal by itself.
 */
const chooseProduction = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  city: City,
  tuning: SimplePolicyTuning,
): ProductionItem | undefined => {
  const options = cityProductionOptions(state, ruleset, city.id);
  if (options.length === 0) return undefined;

  const head = city.production;
  if (head !== undefined) {
    const stillOffered = options.some((item) => item.kind === head.kind && item.id === head.id);
    if (stillOffered) return undefined;
  }

  const cities = citiesOf(state, playerId).length;

  // A settler only while the civilization has neither enough cities nor one already
  // walking. `chooseProduction` runs for every city, so without the settler count a
  // four-city target would queue a settler in every city at once, and settlers that
  // cannot found where they were built would be paid for several times over before
  // any of them arrived anywhere. One at a time is this placeholder's whole expansion
  // model.
  if (cities < tuning.targetCities && countRole(state, ruleset, playerId, 'settler') === 0) {
    const settler = cheapestOfRole(options, ruleset, 'settler');
    if (settler !== undefined) return settler;
  }
  if (countRole(state, ruleset, playerId, 'worker') < tuning.workersPerCity * cities) {
    const worker = cheapestOfRole(options, ruleset, 'worker');
    if (worker !== undefined) return worker;
  }
  if (countRole(state, ruleset, playerId, 'military') < tuning.defendersPerCity * cities) {
    const military = cheapestOfRole(options, ruleset, 'military');
    if (military !== undefined) return military;
  }

  // Nothing the AI specifically wants: spend the shields on the cheapest thing
  // offered, preferring a building (a placeholder taste, and the reason the shipped
  // content's maintenance is exercised by a long run). `options` is non-empty here.
  const buildings = options.filter((item) => item.kind === 'building');
  return cheapest(buildings.length > 0 ? buildings : options, ruleset);
};

/**
 * The assignment `city` should work, or `undefined` when its own is already right.
 *
 * The desired set is the engine's own ranking applied to a *fresh* city: its current
 * assignment is emptied before asking `autoAssignWorkedTiles`, because that helper
 * deliberately excludes the tiles a city already works from its candidates (its
 * caller is a founder assigning from nothing). Asking it directly about a city that
 * already works the best tiles would therefore answer with the *second*-best set —
 * and a policy that set that would have downgraded the city, then swapped back the
 * following turn, for ever. Emptying first asks the question this policy actually
 * means: "if this city assigned from scratch, which tiles would it take?"
 *
 * The result is legal by construction — inside the radius, never the centre, never a
 * tile another city works, at most one per citizen — because those are the exclusions
 * the helper implements. When it equals what the city already works, nothing is
 * emitted: a `SetWorkedTiles` that changes nothing is a revision bump and a hashed
 * state change for no decision.
 */
const chooseWorkedTiles = (
  state: GameState,
  ruleset: RulesetView,
  city: City,
): readonly TileIndex[] | undefined => {
  const cleared: GameState = {
    ...state,
    cities: state.cities.map((candidate) =>
      candidate.id === city.id ? { ...candidate, workedTiles: [] } : candidate,
    ),
  };
  const desired = autoAssignWorkedTiles(cleared, ruleset, city.id, city.population);
  if (desired.length === 0) return undefined;

  const same =
    desired.length === city.workedTiles.length &&
    desired.every((tile, index) => city.workedTiles[index] === tile);
  return same ? undefined : desired;
};

/* ------------------------------------------------------------------ *
 * M5: what this policy researches
 * ------------------------------------------------------------------ */

/**
 * The unit roles this AI actually builds, best first — read from
 * `SIMPLE_POLICY_TUNING`'s own priorities, not from civ-3 judgement.
 *
 * The order mirrors `chooseProduction`: settlers while the city target is unmet, then
 * workers, then military. A tech that unlocks a settler therefore matters more than
 * one that unlocks a swordsman, because the settler is the unit this AI is actually
 * trying to build. The list is the *only* statement of that preference here: the
 * research ranking reads it rather than repeating the priorities, so the two halves of
 * "what this AI wants" cannot drift apart.
 */
const RESEARCH_WANTED_ROLES: readonly UnitRole[] = ['settler', 'worker', 'military'];

/** The rank of a wanted role, larger = wanted more; `0` for a role this AI never builds. */
const wantedRoleRank = (role: UnitRole): number => {
  const index = RESEARCH_WANTED_ROLES.indexOf(role);
  return index < 0 ? 0 : RESEARCH_WANTED_ROLES.length - index;
};

/**
 * How much a tech's unlocks matter to this AI, as one integer: the best (largest)
 * wanted-role rank over the rows the tech unlocks, `1` if it unlocks anything else,
 * and `0` if it unlocks nothing at all.
 *
 * Read through `techUnlocks` — the engine's own statement of "what does knowing this
 * tech unlock" — rather than by scanning the catalogs here. That is the same
 * one-rule-one-reader arrangement the rest of this file follows, and it is why the
 * field can be added to a catalog row without teaching this policy a second read of
 * `requiresTech`.
 *
 * The `1`/`0` split is deliberate and is a placeholder opinion, not a claim: a tech
 * that unlocks a *building* (a marketplace, a library) is worth more to this AI than
 * one that unlocks nothing at all, but less than one that unlocks a unit it is trying
 * to field.
 */
const unlockRank = (ruleset: RulesetView, tech: TechId): number => {
  let rank = 0;
  for (const unlock of techUnlocks(ruleset, tech)) {
    if (unlock.kind !== 'unit') {
      rank = Math.max(rank, 1);
      continue;
    }
    const row = unitCatalog(ruleset).find((def) => def.id === unlock.id);
    rank = Math.max(rank, row === undefined ? 1 : Math.max(1, wantedRoleRank(row.role)));
  }
  return rank;
};

/**
 * A tech's desirability as a rank — larger is better, compared lexicographically by
 * `compareRanks`: unlocks first, then **cheap first**.
 *
 * - `unlockRank` first, because "does this get me something I want?" is the whole
 *   point of research.
 * - Cost second, negated so that the cheaper tech wins. A placeholder AI that
 *   maximised cost would also work, and the choice between the two is taste rather
 *   than evidence; cheap-first is chosen because it makes the AI's *first* research
 *   the affordable one, which is what a real opening looks like, and because it makes
 *   a completion schedule that responds sharply to a cost knob (the balance sweep's
 *   whole reason for existing).
 *
 * The rank deliberately carries **nothing about the tech's id**: two techs with the
 * same unlocks and the same cost are genuinely tied, and the tie is broken once, by
 * id, in the naming pass at the end of `chooseResearch` — not by a component here
 * that would only restate the same comparison in a second spelling.
 */
const researchRank = (ruleset: RulesetView, tech: TechId, cost: number): Rank => [
  unlockRank(ruleset, tech),
  -cost,
];

/**
 * The tech this player should research next, or `undefined` when there is nothing to
 * change.
 *
 * Five decisions, and each one is stated rather than left to the reader:
 *
 * 1. **A selection the player already has is left alone.** Re-issuing the same
 *    `SetResearch` every turn would be legal (the applier treats it as idempotent,
 *    like `SetRates`) and would bump `revision` for nothing; skipping it keeps the
 *    policy's command list — and therefore a run's event stream and final hash —
 *    about *decisions*, not about restating them. Note that this is about the
 *    *selection*: a player whose pool has not yet covered the tech keeps researching
 *    it, which is the whole of "progress".
 * 2. **Legality is the engine's answer, not a copy of it.** Every candidate is folded
 *    through `researchProblem` — the same function `planSetResearch` refuses a
 *    `SetResearch` with and the pipeline consults before completing anything — so a
 *    candidate this policy proposes is one the applier accepts and the pipeline can
 *    finish. The engine's `nothing-being-researched` member is not reachable here
 *    (it answers "what am I researching?", not "may I research this?"), and it is
 *    treated as "not legal" rather than special-cased, because a candidate a policy
 *    cannot show to be researchable is exactly a candidate it must not propose.
 * 3. **Known techs and unknown techs both fall out of that fold.** `already-known`
 *    and `unknown-tech` are refusals, so the candidate list needs no filter of its
 *    own — a second filter would be a second opinion about legality.
 * 4. **Candidates are ranked and then sorted; the winner is never "the best so far".**
 *    A running maximum would keep the first candidate of a tie, and "first" is the
 *    catalog's row order — a decision taken from an array's positions, which the
 *    module note forbids. Collecting, then sorting by `(rank desc, id asc)`, gives one
 *    answer per set of candidates and makes the whole function independent of row
 *    order, which `policies.test.ts` checks by replaying seeds against shuffled rows.
 * 5. **It reads no randomness.** The choice is a total order over the content, so the
 *    same `(state, ruleset)` always produces the same command; the policy never calls
 *    `ctx.rng` for it, because a draw here would also move every later draw in the
 *    policy's own stream and a balance comparison between two strategies would stop
 *    being one.
 *
 * `known` is the caller's view of what the player knows, which is `knownTechs(player)`
 * plus any tech this same turn has already successfully selected, so the policy cannot
 * propose a selection it has just made.
 */
const chooseResearch = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  known: readonly TechId[],
): TechId | undefined => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) return undefined;

  // The selection this player already has, read totally (`undefined` when the key is
  // absent, which is what "not researching" means).
  const selected = researchingOf(player);
  // The engine's rule, asked with the caller's knowledge rather than the state's: a
  // tech selected earlier in this turn is not in the state yet.
  const knower = { ...player, techs: known };

  const candidates: { readonly tech: TechId; readonly rank: Rank }[] = [];
  for (const row of techCatalog(ruleset)) {
    // A row this engine cannot price is not a candidate: `researchProblem` would say
    // so, but asking it about every unpriced row is work whose answer cannot matter.
    const cost = techCostOf(ruleset, row.id);
    if (cost === undefined) continue;
    // Already known — the engine's own rule would refuse it, and asking is cheaper than
    // the fold below is. (`researchProblem` would answer `already-known` either way;
    // this is the same rule read from the same list the fold is given.)
    if (known.includes(row.id)) continue;
    if (researchProblem(ruleset, knower, row.id) !== undefined) continue;

    candidates.push({ tech: row.id, rank: researchRank(ruleset, row.id, cost) });
  }

  if (candidates.length === 0) return undefined;

  const best = [...candidates].sort((a, b) => {
    const byRank = compareRanks(b.rank, a.rank); // larger rank first
    if (byRank !== 0) return byRank;
    return compareText(String(a.tech), String(b.tech));
  })[0];
  if (best === undefined) return undefined;

  return best.tech === selected ? undefined : best.tech;
};

/* ------------------------------------------------------------------ *
 * One turn of the simple policy
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * M6 — combat
 * ------------------------------------------------------------------ */

/** The `AttackUnit` command, as the enumerator issues it. */
type AttackCommand = Extract<Command, { type: 'AttackUnit' }>;

/** What one fold of an attack told this policy about it. */
interface AttackChoice {
  readonly command: AttackCommand;
  /** Whether it takes an undefended city rather than fighting a defender. */
  readonly capture: boolean;
  /** The applier's own per-round odds, in whole percent (`CombatResolved.attackerWinPct`). */
  readonly odds: number;
}

/**
 * The best attack this unit may make, or `undefined` when it may make none.
 *
 * **The policy asks the engine, in the strongest form available.** Every candidate comes
 * from `unitActions` (the enumerator that shares `planAttackUnit` with the applier, so
 * this cannot propose an attack the applier would refuse — the keystone invariant, both
 * directions), and every candidate is then *folded* through `applyCommand` on the
 * scratch state. What is read off that fold is the engine's **own answer about the
 * fight**: the `attackerWinPct` on the `CombatResolved` event for a battle, and the
 * presence of a `CityCaptured` event for a capture. No statistic here is recomputed from
 * the ruleset — terrain bonuses, city walls, fortification, the veteran bonus and the
 * odds formula itself are all `combat.ts`' rule, and a policy that re-derived them would
 * be a second home for it.
 *
 * **The fold is discarded, and that is not a wasted draw.** `applyCommand` is pure, so
 * the scratch fold advances a copy of the RNG that goes nowhere; the attack this function
 * selects is applied again, once, by `attempt` on the real `current` — which draws from
 * the same state and therefore produces the same battle. What is deliberately **not**
 * read off the fold is the *result*: `attackerSurvives` and the losses would tell this
 * policy in advance exactly which attacks win, and a policy with perfect foresight plays
 * a game no balance sweep is measuring. The decision is taken on the **odds**, which are
 * a pure function of the state and carry no draw at all.
 *
 * A capture ranks above every battle (there is no defender to lose to), and within
 * either kind the higher odds win; a tie keeps the **earlier** candidate, which is the
 * enumerator's own order (ascending tile index), so the choice is total without a second
 * comparison being invented here.
 */
const bestAttack = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
): AttackChoice | undefined => {
  let best: AttackChoice | undefined;

  for (const command of unitActions(state, ruleset, unitId)) {
    if (command.type !== 'AttackUnit') continue;

    const outcome = applyCommand(state, playerId, command, ruleset);
    if (!outcome.ok) continue;

    const resolved = outcome.value.events.find(
      (event): event is Extract<GameEvent, { type: 'CombatResolved' }> =>
        event.type === 'CombatResolved',
    );
    const capture = outcome.value.events.some((event) => event.type === 'CityCaptured');
    // A legal attack that produced neither line would be an engine bug, not a choice:
    // `planAttackUnit` decides between exactly those two cases, and both emit their
    // event. Counting it as odds 0 (rather than skipping it) keeps this total and keeps
    // such an attack out of the "profitable" branch, which is the conservative reading.
    const choice: AttackChoice = {
      command,
      capture,
      odds: resolved === undefined ? 0 : resolved.attackerWinPct,
    };

    if (best === undefined) {
      best = choice;
      continue;
    }
    const rank = compareRanks(
      [choice.capture ? 1 : 0, choice.odds],
      [best.capture ? 1 : 0, best.odds],
    );
    if (rank > 0) best = choice;
  }

  return best;
};

/**
 * Is this unit face to face with an enemy — an enemy unit or an enemy city on one of
 * the eight tiles beside it?
 *
 * Both readings are the engine's: adjacency is `neighbors8` (the same ring
 * `planAttackUnit` and `planMove` use), "who is on this tile" is `unitsOnTile`, and
 * "whose city is this" is `cityAt`. No line of sight, no reachability and no threat
 * model is involved, because this engine has none of those and this policy is a
 * placeholder.
 */
const inContact = (state: GameState, playerId: PlayerId, unit: Unit): boolean => {
  for (const tile of neighbors8(state.map, unit.tile)) {
    if (unitsOnTile(state, tile).some((other) => other.owner !== playerId)) return true;
    const city = cityAt(state, tile);
    if (city !== undefined && city.owner !== playerId) return true;
  }
  return false;
};

/** How many steps a unit may be handed this turn: its own budget, or the guard. */
const stepBudget = (movement: number): number => {
  const own = Number.isInteger(movement) && movement > 0 ? movement : 0;
  return Math.min(own, MAX_STEPS_PER_UNIT);
};

const planTurn = (ctx: PolicyContext, tuning: SimplePolicyTuning): readonly Command[] => {
  const ruleset: RulesetView = ctx.ruleset;
  const playerId = ctx.playerId;
  const planned: Command[] = [];
  let current: GameState = ctx.state;

  /**
   * Fold one candidate through the engine's own applier.
   *
   * A refusal simply drops the candidate: the state is untouched by a refused
   * command (`applyCommand` is pure), and this policy is a placeholder — the honest
   * answer to "the engine would not let me do that" is to do something else, not to
   * throw inside a 50-game batch. What matters is that nothing illegal reaches the
   * runner, and `policies.test.ts` asserts that every command this policy returns
   * applies successfully, in order, from the state it saw.
   */
  const attempt = (command: Command): boolean => {
    const outcome = applyCommand(current, playerId, command, ruleset);
    if (!outcome.ok) return false;
    current = outcome.value.state;
    planned.push(command);
    return true;
  };

  // Cities before units, and the order is a decision: `FoundCity` auto-assigns the
  // new city's worked tiles **at the moment it applies**, against whatever claims
  // exist then. Assigning an existing city first means the new city's assignment
  // already knows about it and picks different tiles, whereas the reverse order would
  // make the founder's tiles a surprise the earlier command cannot have accounted
  // for. The engine would refuse the loser; this way there is no loser.
  for (const city of citiesOf(current, playerId)) {
    const item = chooseProduction(current, ruleset, playerId, city, tuning);
    if (item !== undefined) attempt({ type: 'SetProduction', cityId: city.id, item });

    const tiles = chooseWorkedTiles(current, ruleset, city);
    if (tiles !== undefined) attempt({ type: 'SetWorkedTiles', cityId: city.id, tiles });
  }

  // M5: research, once per turn, after the cities and before the units. The position
  // is a decision and it is *not* observable in the way the engine's pipeline order
  // is — `SetResearch` only writes a selection, and selections take effect at the next
  // turn's research step regardless of when in this turn they were made — so this
  // placement is about reading order rather than about a rule. It sits between the two
  // loops because it is a *civilization* decision, like production, and because the
  // `current` state it must fold against is already the one the city commands produced.
  //
  // `known` starts from the state and grows by whatever this turn actually selects, so
  // a second call in the same turn cannot re-propose the tech it just chose. The tech
  // is read back off `current` rather than assumed: `attempt` returns whether the
  // applier accepted the command, and a selection the engine refused must not be
  // recorded as one this AI made.
  const known: TechId[] = [];
  const researching = current.players.find((candidate) => candidate.id === playerId);
  if (researching !== undefined) known.push(...knownTechs(researching));
  const tech = chooseResearch(current, ruleset, playerId, known);
  if (tech !== undefined && attempt({ type: 'SetResearch', tech })) known.push(tech);

  // Units, in id order (`state.units` is sorted by id). The list is a snapshot of
  // ids, and each id is re-read from `current` before it is acted on: a settler that
  // founded a city earlier in this loop is gone from the state, and a policy that
  // acted on its snapshot would propose a move for a unit that no longer exists.
  const owned = current.units.filter((unit) => unit.owner === playerId).map((unit) => unit.id);

  for (const unitId of owned) {
    const unit = unitById(current, unitId);
    if (unit === undefined) continue;

    const def = unitDef(ruleset, unit.type);
    // A unit type this ruleset does not describe is left alone: the engine cannot say
    // what it may do, and guessing a role for it would be inventing rules.
    if (def === undefined) continue;

    if (def.role === 'settler' && planFoundCity(current, ruleset, playerId, unitId).ok) {
      attempt({ type: 'FoundCity', unitId });
      continue;
    }

    if (def.role === 'worker') {
      // A working unit is left where it is: a step **cancels** its job (M4a), and this
      // AI has no reason to abandon a job it chose.
      if (unit.work !== undefined) continue;
      const job = chooseJob(unitActions(current, ruleset, unitId), ruleset);
      // An idle worker with nothing it may build here stays put. Stated limitation:
      // "walk to a tile that needs improving" is a real M7 heuristic, and inventing
      // one here would be a strategy claim this placeholder does not make.
      if (job !== undefined) attempt(job);
      continue;
    }

    // M6: combat, and it comes **before any movement**. An attack spends the unit's
    // whole remaining movement (`applyBattle`), so proposing a step first would either
    // waste the step or make the attack unaffordable — and a `FortifyUnit` is refused
    // without movement for the same reason.
    //
    // The order inside this block is the whole policy: fight only when the engine's own
    // odds clear the floor (or when there is a city to take and nobody to fight), and
    // otherwise, in contact, **hold the ground**. "Avoid" is read here as "does not
    // wander": this AI has no threat model and no pathfinder, so walking away from a
    // stronger enemy is a strategy claim it does not make, whereas standing still behind
    // the fortification bonus is a rule the engine already states.
    const attack = bestAttack(current, ruleset, playerId, unitId);
    if (attack !== undefined && (attack.capture || attack.odds >= tuning.attackOddsFloorPct)) {
      if (attempt(attack.command)) continue;
    }

    if (def.role === 'military' && inContact(current, playerId, unit)) {
      // Only when it is not already dug in: `FortifyUnit` is about spending a movement
      // point, and re-issuing it every turn would be a command that says nothing.
      if (!isFortified(unit)) attempt({ type: 'FortifyUnit', unitId });
      continue;
    }

    const rank =
      def.role === 'settler'
        ? settleRanker(ruleset, playerId, unitId)
        : exploreRanker(ruleset, playerId);
    for (let step = 0; step < stepBudget(def.movement); step += 1) {
      const moving = unitById(current, unitId);
      if (moving === undefined) break;
      const command = bestStep(current, ruleset, moving, rank);
      if (command === undefined) break;
      if (!attempt(command)) break;
    }
  }

  return planned;
};

/* ------------------------------------------------------------------ *
 * The shipped policies
 * ------------------------------------------------------------------ */

/**
 * The baseline: it decides nothing.
 *
 * Its commands are an empty list on every turn of every game, which makes it the
 * control every balance comparison needs — the same seed, the same world, no
 * decisions — and it is also how a run reports `stoppedBecause: 'no-commands'`. It is
 * a **placeholder** for M7's real AI in the same sense as `SIMPLE_POLICY`: it is not a
 * strategy, it is the absence of one, kept because "what does the world do on its own?"
 * is a question a balance sweep has to be able to ask.
 *
 * Note that the world still moves under it: growth, production and the money loop run
 * every turn regardless of what any policy says, because a turn is the engine's, not
 * the AI's.
 */
export const DO_NOTHING_POLICY: Policy = {
  name: 'do-nothing',
  chooseCommands: () => [],
};

/**
 * The simple policy, optionally with this policy's thresholds overridden.
 *
 * `simplePolicy({ targetCities: 2 })` is how a sweep varies the AI's taste without
 * editing this file. The `??` per field is not defensive noise: a caller that reaches
 * this from JSON can put a key holding `undefined` into the patch, and a spread alone
 * would then write `undefined` over a real default.
 */
export const simplePolicy = (patch: Partial<SimplePolicyTuning> = {}): Policy => {
  const tuning: SimplePolicyTuning = {
    targetCities: patch.targetCities ?? SIMPLE_POLICY_TUNING.targetCities,
    workersPerCity: patch.workersPerCity ?? SIMPLE_POLICY_TUNING.workersPerCity,
    defendersPerCity: patch.defendersPerCity ?? SIMPLE_POLICY_TUNING.defendersPerCity,
    attackOddsFloorPct: patch.attackOddsFloorPct ?? SIMPLE_POLICY_TUNING.attackOddsFloorPct,
  };

  return {
    name: 'simple-placeholder',
    chooseCommands: (ctx) => planTurn(ctx, tuning),
  };
};

/** The simple policy at its default tuning. **PLACEHOLDER** for M7's real AI. */
export const SIMPLE_POLICY: Policy = simplePolicy();
