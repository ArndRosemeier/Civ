/**
 * Legal actions — the single source of truth for "what may this player do now?",
 * shared by the AI, the UI and the tests (PLAN.md §5.2, PLAN.md §5.3's "one
 * source of truth for legality, so UI and AI cannot disagree with the engine").
 * See docs/INTERFACES.md, M2 ("Core — commands, errors, legal actions"), M3
 * ("Commands (added to the frozen union)") and M4a ("Workers", "Commands").
 *
 * Design notes:
 *
 * - **Legality is not restated here.** Every candidate tile is filtered through
 *   `planMove`, `FoundCity` is offered only when `planFoundCity` — the same
 *   evaluators `applyCommand` refuses with — accepts it, and M4a's two work
 *   commands are offered only where `planStartWork` / `planCancelWork` accept
 *   them. So a yielded action cannot be one the engine would reject. That is the
 *   keystone property (INTERFACES.md, invariant 1, as amended): the UI cannot
 *   offer a move that fails, and the AI cannot waste a decision on one.
 * - **The agreement runs both ways.** These generators are the *complete*
 *   statement of what a player may do, not merely a sound subset: every command
 *   `applyCommand` accepts for a real player is one of these. Where the two could
 *   disagree the applier was made total (`EndTurn` in `commands.ts`), not the
 *   generator silent — an adversarial sweep found `legalActions` yielding an
 *   `EndTurn` that `applyCommand` refused when a unit's type was missing from the
 *   ruleset, and the honest fix is for the turn to apply. `actions.test.ts`
 *   asserts both directions on every board it builds, that state included, and
 *   M4a's work commands extend the sweep to five generators rather than three.
 *   M4b's `planSetRates` is the sixth: the rate space is a query, not an
 *   enumeration, for the reasons in the `SetRates` note below. M5's `planSetResearch`
 *   is the seventh, on the same queried side and for a related reason — the tree is
 *   content the UI renders in full, refusals included, so it is not a generator's
 *   job to enumerate it.
 * - **`StartWork` is enumerated over the catalog, and that is complete.** The
 *   command names an improvement kind, so "every way this worker may start work"
 *   is exactly "every kind this ruleset can build here" — a finite list read from
 *   `improvementCatalog`, filtered by `planStartWork`, which is the applier's own
 *   evaluator. Duplicate ids in a foreign catalog are collapsed, because the
 *   applier's accepted set has one `StartWork` per *distinct* kind and a generator
 *   that yielded the same command twice would be advertising a choice that is not
 *   there.
 * - **Cities are queried, not enumerated.** `legalActions` offers `FoundCity` for
 *   every settler that can found one, because founding is a *unit's* action: the
 *   unit either can or cannot, and the command space is one entry per unit.
 *   `SetWorkedTiles` and `SetProduction` are deliberately **not** yielded: a
 *   production item is a content choice and an assignment is a search space
 *   (`C(radius, population)` candidates, not an action list), so a generator that
 *   yielded "the" assignment would be advertising an arbitrary subset as if it
 *   were the whole of what is legal — the most dangerous kind of incomplete
 *   generator, because it looks complete. Their legality is still stated once, in
 *   `planSetWorkedTiles` / `planSetProduction`, and `actions.test.ts` sweeps a
 *   candidate universe of both legal and illegal choices through those evaluators
 *   against `applyCommand` in both directions.
 * - **The work commands *are* yielded**, unlike the two city setters, and the
 *   difference is not an inconsistency: a worker's job is one entry per catalog
 *   row — the unit either can start *that* job here or it cannot — so the
 *   enumeration is the whole space, not a sample of it. `CancelWork` is a single
 *   question about the unit's own state, and it is legal exactly when the unit is
 *   working.
 * - **M4c's resource gate is mirrored here, through the applier's own evaluator.**
 *   `cityProductionOptions` lists what a city may be set to build by filtering the
 *   catalog through `planSetProduction` — the same function `applyCommand` refuses
 *   with, resource gate included — so a unit whose `requiresResource` the owner has
 *   not connected is **not offered**, and (the other direction) everything offered
 *   is something the applier accepts. That is the mirror the keystone invariant
 *   asks for, and it is a *query* rather than a `legalActions` yield for the reason
 *   the setters are: `SetProduction` emits no event, and the committed adversarial
 *   sweeps treat "an advertised action with no observable effect" as a generator
 *   that has drifted. `actions.test.ts` sweeps the options against `applyCommand`
 *   in both directions.
 * - **M5's tech gate reaches this menu through its own verdict** (`productionGate`),
 *   which `planSetProduction` and `production.ts`' completion pass ask as well — one
 *   rule, three askers, the arrangement the bullet above describes. The planner now
 *   asks it too (M5's integration wave closed the wiring this comment used to say was
 *   owed), so this conjunct is a redundant restatement of a rule the planner already
 *   applies: a tech-gated item is absent from the menu *and* refused by
 *   `applyCommand`, with the same typed `tech-required`. Written as the same verdict
 *   and not as a filter of its own, which is why the agreement is by construction
 *   rather than by review.
 * - **`SetRates` (M4b) is a query too, and the sixth generator is its evaluator.**
 *   `planSetRates` is the applier's own decision — "this actor exists, and this
 *   triple is three integers `>= 0` summing to `RATE_TOTAL`" — and `applyCommand`
 *   refuses with it, so the two cannot disagree. What this module does **not** do is
 *   enumerate the rate space, and that is a stated decision rather than an
 *   oversight:
 *   - the space is *not* small. Every triple of non-negative integers summing to
 *     `RATE_TOTAL` is legal, which at `RATE_TOTAL = 10` is 66 commands, per player,
 *     per call. `legalActions` is the AI's and the UI's hot path (PLAN.md §5.2), and
 *     a 66-entry block of slider moves beside a settler's five steps is a bad
 *     answer to "what can I do now?" — the argument M3 already made for
 *     `SetWorkedTiles` and `SetProduction`, whose spaces are larger but of the same
 *     kind;
 *   - and every one of those 66 commands is **invisible in the event stream**:
 *     `SetRates` writes a setting and emits nothing (M3's setter precedent — the
 *     payload is the record of the change). The committed adversarial sweeps treat
 *     "an advertised action applied without emitting an event" as a failure
 *     (`packages/testing/test/m2-adversarial.test.ts`,
 *     `packages/testing/test/m4a-adversarial.test.ts`), and they are right to: an
 *     advertised action with no observable effect is exactly the shape of a
 *     generator that has drifted from the applier. Enumerating rates would either
 *     fail those sweeps or require a new `GameEvent` member, which the frozen M4b
 *     event list does not name (`IncomeCollected`, `UpkeepPaid`, `UnitDisbanded`,
 *     `TreasuryShortfall` are the money loop's four).
 *
 *   So this module yields **no** `SetRates`, the way it yields no `SetWorkedTiles`
 *   or `SetProduction`: legality is stated once, in `planSetRates`, and
 *   `actions.test.ts` sweeps a candidate universe of legal *and* illegal triples
 *   through that evaluator against `applyCommand` in **both** directions — the
 *   keystone property, held for the sixth generator without pretending a slider is
 *   a move. (`RATE_TOTAL`'s shape makes this cheap: a caller that wants a rate
 *   choice asks `planSetRates` about the triple it has in mind, which is what a
 *   slider UI does anyway.)
 * - **Deterministic order.** Units are visited in `state.units` order (sorted by
 *   id, INTERFACES.md M2); each unit yields `FoundCity` (when it can found), then
 *   one `StartWork` per accepted catalog kind, then `CancelWork` (when it is
 *   working), then its moves, sorted ascending by tile index; `EndTurn` is last.
 *   The own-tile actions come before the moves because a move *relocates* the unit
 *   and relocation cancels a job (M4a) — the irreversible side effect sits last,
 *   after the choices that keep the unit where it is. Two calls on the same state
 *   yield identical sequences — a precondition for the AI, for transcripts and for
 *   state hashes.
 * - **Fog is not a legality rule in M2.** Whether a tile is explored never
 *   affects a unit's options (INTERFACES.md M2, "Fog"): visibility is a rendering
 *   concern for `textview`, not a movement constraint. Nor is it one in M3 —
 *   founding a city does not require that the player has "seen" the site, only
 *   that the settler is standing on it — nor in M4a, where a worker improves the
 *   tile it stands on and nothing asks who else has looked at it.
 * - **`legalActions` is lazy.** It is a generator so a caller that wants the
 *   first legal action (the REPL, a scripted scenario, a search that prunes)
 *   never materialises the whole space (PLAN.md §5.2).
 */

import { buildingCatalog, cityById, type ProductionItem } from './cities.js';
import {
  planCancelWork,
  planFoundCity,
  planMove,
  planSetProduction,
  planStartWork,
  type Command,
} from './commands.js';
import { improvementCatalog, type ImprovementId } from './improvements.js';
import type { CityId, PlayerId, TileIndex, UnitId } from './ids.js';
import { neighbors8, type RulesetView } from './map.js';
import { productionGate } from './resources.js';
import type { GameState } from './state.js';
import { unitById, unitCatalog } from './units.js';

/**
 * Every adjacent tile `unitId` may legally step onto, in ascending tile-index
 * order. Empty when the unit does not exist, when nothing is affordable, or when
 * every neighbour is impassable or held by another player.
 *
 * This is the AI's and the UI's hot path (PLAN.md §5.2 / §5.4: movement options
 * are computed once per unit per turn, not per query), so it is a filtered scan
 * of the 8 neighbours rather than an enumeration of the command space. Legality
 * is decided by the unit's own owner — a per-unit query has no acting player — so
 * a state whose unit belongs to a player missing from `state.players` (corrupt,
 * or hand-built) offers nothing, which is the same answer `applyCommand` gives
 * such an actor. The caching layer PLAN.md §5.4 mentions would key on
 * `state.revision`.
 */
export const unitMoveOptions = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): readonly TileIndex[] => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return [];

  const options = neighbors8(state.map, unit.tile).filter(
    (to) => planMove(state, ruleset, unit.owner, unitId, to).ok,
  );

  // `neighbors8` happens to emit ascending indices; sorting states the guarantee
  // rather than depending on that implementation detail.
  return [...options].sort((a, b) => a - b);
};

/**
 * Every command `unitId` can currently issue, in order:
 *
 * 1. `FoundCity` — a settler's defining action, and the one that ends its life as
 *    a unit;
 * 2. one `StartWork` per improvement this ruleset can build where the unit stands,
 *    in catalog order (M4a) — a worker's defining action, and one that commits the
 *    rest of its turn;
 * 3. `CancelWork` when the unit is working — the way back out of a job;
 * 4. one `MoveUnit` per tile in `unitMoveOptions` order.
 *
 * The own-tile actions come before the moves because a move relocates the unit and
 * *relocation cancels an in-flight job* (M4a): the destructive act is listed last,
 * after everything that leaves the unit where it is. `CancelWork` is inside that
 * own-tile group because a caller scanning the list for "what can this unit do
 * here?" should see the whole answer before the list starts offering to walk away.
 *
 * A unit's actions are its own: `EndTurn` is a *player* action, not something a
 * unit does, so it is yielded by `legalActions` alone. Neither are the two city
 * commands — see the module note on why they are queries rather than enumerated
 * actions. An unknown unit has no actions; the empty list is the answer, not an
 * error, because asking about a unit that is not there is a question the UI asks
 * every frame.
 *
 * Every command below is offered exactly when the applier's own evaluator accepts
 * it: `planFoundCity`, `planStartWork`, `planCancelWork`, `planMove` — acting as
 * the unit's own owner, since a per-unit query has no acting player. So a settler
 * is not offered a city it cannot found, a scout is not offered a mine, a worker
 * standing on grassland is not offered a mine, a worker on an already-mined hill
 * is not offered that mine again, and a worker with no movement left is offered no
 * job at all.
 */
export const unitActions = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): readonly Command[] => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return [];

  const found: readonly Command[] = planFoundCity(state, ruleset, unit.owner, unitId).ok
    ? [{ type: 'FoundCity', unitId }]
    : [];

  // One candidate per *distinct* catalog kind, in catalog order, each decided by
  // `planStartWork` — the evaluator `applyCommand` refuses with. The applier's
  // accepted set is exactly this set, which is what makes the enumeration complete
  // rather than a sample: a job is named by its kind, and a kind is a finite list.
  const kinds: readonly ImprovementId[] = [
    ...new Set(improvementCatalog(ruleset).map((def) => def.id)),
  ];
  const started: readonly Command[] = kinds
    .filter((kind) => planStartWork(state, ruleset, unit.owner, unitId, kind).ok)
    .map((kind): Command => ({ type: 'StartWork', unitId, kind }));

  const cancelled: readonly Command[] = planCancelWork(state, unit.owner, unitId).ok
    ? [{ type: 'CancelWork', unitId }]
    : [];

  const moves: readonly Command[] = unitMoveOptions(state, ruleset, unitId).map((to): Command => ({
    type: 'MoveUnit',
    unitId,
    to,
  }));

  return [...found, ...started, ...cancelled, ...moves];
};

/**
 * Every production item `cityId` may legally be set to build, in catalog order:
 * the unit catalog first, then the building catalog, each with duplicate ids
 * collapsed, filtered through `planSetProduction` — the evaluator `applyCommand`
 * refuses with.
 *
 * **This is the mirror `SetProduction`'s legality needs.** The applier refuses an
 * item this ruleset cannot price, a building the city already has, and — M4c — a
 * unit whose `requiresResource` the city's owner has not connected. A UI that
 * built its menu from `unitCatalog` alone would offer exactly that unit, so the
 * enumeration has to be made of the applier's own verdicts rather than of the
 * catalog, and the resource-gated unit simply does not appear. The other direction
 * holds too: every item this yields is one `applyCommand` accepts out of the same
 * catalog, which `actions.test.ts` asserts on boards with and without a connected
 * resource.
 *
 * A `cityId` the state does not hold yields `[]` — asking about a city that is not
 * there is a question a UI asks every frame, and "nothing" is the honest answer.
 * The acting player is the city's own owner, exactly as `unitMoveOptions` acts for
 * the unit's owner: a per-city query has no separate actor, and a state whose
 * owner is missing from `players` offers nothing, which is what `applyCommand`
 * says about such an actor too.
 *
 * Deliberately **not** yielded by `legalActions`, on the precedent M3 set for the
 * two setters and M4b's amendment recorded: a production choice is a search space
 * over content, not an action list, and `SetProduction` emits no event — so
 * advertising it would put a no-op-looking command in the event-driven sweeps.
 * Legality is still stated once, in `planSetProduction`; this function is how the
 * gate reaches the UI and the AI.
 */
export const cityProductionOptions = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
): readonly ProductionItem[] => {
  const city = cityById(state, cityId);
  if (city === undefined) return [];

  const candidates: readonly ProductionItem[] = [
    ...unitCatalog(ruleset).map((def): ProductionItem => ({ kind: 'unit', id: def.id })),
    ...buildingCatalog(ruleset).map((def): ProductionItem => ({ kind: 'building', id: def.id })),
  ];

  const seen = new Set<string>();
  const options: ProductionItem[] = [];
  for (const item of candidates) {
    // Duplicate ids in a foreign catalog are collapsed, because the applier's
    // accepted set has one entry per *distinct* item and a generator that listed
    // the same item twice would be advertising a choice that is not there — the
    // same reading `unitActions` applies to improvement kinds.
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!planSetProduction(state, ruleset, city.owner, cityId, item).ok) continue;
    // M5's third gating dimension, asked of the gate that owns it rather than
    // reimplemented here: an item whose own row — or whose *resource*'s row — demands
    // a tech this owner has not researched is not offered, because the production
    // pass will not complete it (`production.ts` asks the same gate). Two askers, one
    // verdict (`productionGate`), which is the same arrangement M4c gave the resource
    // rule. Owed wiring, named in `resources.ts` and in the report rather than
    // implied: `planSetProduction` itself does not ask this gate yet, so until it does
    // this conjunct is the only place the *menu* refuses a tech-gated item.
    if (productionGate(state, ruleset, city.owner, item).kind !== 'open') continue;
    options.push(item);
  }

  return options;
};

/**
 * Every command `playerId` may issue right now, lazily: each of that player's
 * units' actions in id order, then one `EndTurn`.
 *
 * A player id that no player in the state carries yields nothing at all — an
 * absent player has no legal actions, and yielding an `EndTurn` that
 * `applyCommand` would refuse as `unknown-player` would break the keystone
 * property for exactly the input a mistyped id produces.
 *
 * `EndTurn` is always legal for a real player: M2 has no turn-order state to
 * violate, and the command layer refuses only what the rules forbid.
 *
 * M4b's `SetRates` is deliberately **not** among these yields, for both
 * barbarians and civilizations: it is a setting over a 66-triple space with no
 * event of its own, and `planSetRates` is its evaluator — see the module note.
 *
 * M5's `SetResearch` is **not** yielded either, and for a reason worth separating
 * from `SetRates`': there is no combinatorial space here (a ruleset ships a finite
 * list of techs) but the list is *content*, not an action — it is what the router
 * renders in a tree, complete with the techs this player may not have yet, so a
 * generator that yielded "every researchable tech" would be advertising a menu as if
 * it were the whole of what is legal, while the refusals a player most needs to see
 * (an unmet prerequisite, a tech already known) are exactly the ones no generator
 * emits. Its legality is `planSetResearch` — the same evaluator `applyCommand`
 * refuses with and the same research rule the pipeline consults (`tech.ts`), so the
 * two directions of the keystone property hold by construction rather than by a
 * second list of techs here. `actions.test.ts` sweeps the whole catalog plus unknown
 * ids through `planSetResearch` against `applyCommand` and asserts that no
 * `SetResearch` is ever advertised.
 */
export function* legalActions(
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): Generator<Command> {
  if (!state.players.some((player) => player.id === playerId)) return;

  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    for (const action of unitActions(state, ruleset, unit.id)) yield action;
  }

  yield { type: 'EndTurn' };
}
