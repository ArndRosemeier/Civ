/**
 * Resources — which of them a player has **connected**, whether a unit's
 * requirement is satisfied, and what a bonus resource does to the tile it sits
 * on. See docs/INTERFACES.md M4c ("Resources"), PLAN.md §5.3 (determinism) and
 * §5.4 (data layout).
 *
 * Design notes:
 *
 * - **The connection rule is stated here, once, and nothing else re-derives it.**
 *   M4c's rule verbatim: "a resource is connected for a player if some **city of
 *   that player** reaches the resource tile through a path of road-improved tiles
 *   (8-way, endpoints inclusive). Deterministic BFS; no path length limit."
 *   `connected` is that sentence in code and the only implementation of it; the
 *   production gate (`resourceGate`, called from `commands.ts`'s
 *   `planSetProduction`) *asks* it rather than re-walking the map. M2 lost a bug
 *   hunt to two writers of the explored layer, and M4c's own contract calls that
 *   out: availability computed two ways in two places is exactly that bug. There
 *   is one walk here, so there is nothing to disagree with.
 * - **Connection is a property of the player, not of one city.** The sentence above
 *   quantifies over "some city of that player", so a resource is connected for the
 *   *player* if *any* of its cities reaches it, and the gate therefore asks about
 *   the owner and not about the individual city doing the building. That is stated
 *   rather than implied because the alternative (a per-city reach) is a plausible
 *   misreading of "a city connected by road to a strategic resource" in the M4c
 *   acceptance evidence.
 * - **Endpoints inclusive.** The city centre a walk starts from needs no road (a
 *   centre *is* a node of the trade network), and neither does the resource tile a
 *   walk ends on: a road chain that stops next to the iron connects the iron.
 *   Everything between them must be road-improved, which is what makes a missing
 *   link in the middle break the connection.
 * - **"Road-improved" is read from the catalog, never from a hard-coded id.** A
 *   tile counts when it carries an improvement whose catalog row has
 *   `kind: 'road'`, so a ruleset that calls its road `highway` still works and
 *   renaming a row cannot silently disconnect a whole civilization. A view that
 *   ships no road row connects nothing, which is arithmetic rather than a special
 *   case.
 * - **No terrain, ownership or distance rule.** M4c has no borders and no harbor
 *   equivalent, and the frozen rule above names none: a road over a mountain
 *   range still connects, because the contract's path is a path of *road tiles*.
 *   Adding a terrain filter here would be inventing a rule the contract does not
 *   have; a distance cap would contradict "no path length limit" outright.
 * - **Barbarians have no economy, so they have no connections.** Their `connected`
 *   set is empty — not because their roads would be walked differently, but
 *   because M4c's contract says so in as many words, and because every consumer of
 *   a connection is an economic one (gating production, counting luxuries).
 * - **Bonus resources are terrain; strategic and luxury ones are not.** A `bonus`
 *   row's `yields` are added to the tile it sits on, on top of terrain and
 *   improvements, and are neither gated nor connected; a `strategic` row's only
 *   effect in M4c is the gate, and a `luxury` row's only effect is being placed,
 *   connected and counted. `bonusYieldsAt` is therefore the one place a resource
 *   touches a tile's worth, and it adds nothing for the other two kinds.
 * - **Luxuries do NOTHING for happiness until M9.** They are placed on the map
 *   (`gen.ts`), connected (`connected`) and countable (the size of that set), and
 *   **no function here reads them for contentment** — there is no happiness value
 *   in the engine at all yet. Saying that plainly is the point of this bullet: a
 *   reader who finds luxuries "connected and counted" must not infer that
 *   contentment is modelled, because it is not, and a luxury that quietly changed
 *   a yield or a mood would be exactly the kind of claim this project's provenance
 *   rule exists to prevent.
 * - **M5: a resource row may declare `requiresTech`, and this is where that is
 *   honoured.** M5's Gating section gives units, buildings, improvements and
 *   resources an optional `requiresTech` — for a resource, "when the resource
 *   becomes visible and connectable". A resource whose row declares a tech the
 *   player does not know is therefore **not connected**, and the filter that says
 *   so sits inside `connected`, the one implementation of "which resources does
 *   this player have?". Every consumer — the production gate below, a luxury count,
 *   the REPL — inherits that answer instead of re-deciding it. What the field does
 *   *not* mean is worth stating, because the contract's word "visible" has no
 *   second meaning in this engine: there is no per-player resource-visibility
 *   layer (fog is per-*tile*, `fog.ts`), so connectability is the whole of it.
 * - **M5: a production item's tech requirement is the third gating dimension, and
 *   it is stated beside the resource gate.** `productionGate` is that verdict —
 *   `open`, `tech-required` (naming the tech) or `blocked` (naming the resource) —
 *   and it is the one function the planner and the applier are meant to ask, which
 *   is the arrangement M4c established for `resourceGate` so that a generator and
 *   an applier cannot disagree about what an item needs. Under it, `unmetTechFor` is
 *   the generic read (any spec row, one player), `requiredTechOf` resolves a
 *   production item to the tech its own row declares, and `unmetItemTech` adds the
 *   second way an item can be tech-gated: the resource it requires is itself locked
 *   behind a tech. The *rule* those compose is `tech.ts`' `requiresTechOf` +
 *   `unmetTechRequirement` — the one read of the field and the one test of "is this
 *   requirement met?" — so this module adds no second opinion about either.
 * - **Wiring note: who asks the gate — all three askers, since M5's integration.** Three
 *   askers exist and they ask *this* verdict rather than a copy of it: `planSetProduction`
 *   (`commands.ts`, the evaluator `applyCommand` refuses with and therefore the one the
 *   keystone invariant is about), `cityProductionOptions` (`actions.ts`), which is what a
 *   city may be *set* to build, and the completion pass in `applyProduction`
 *   (`production.ts`), which is what a city may actually *produce*. That is the
 *   one-rule-three-askers arrangement this module was built for, so the generator and the
 *   applier cannot disagree about a unit or a building row that declares a tech — the
 *   property `actions.test.ts`' production-options sweep asserts in both directions.
 *
 *   **This bullet used to describe an owed patch, and the patch landed.** Until M5's
 *   integration wave `planSetProduction` asked `resourceGate` alone, so `applyCommand`
 *   accepted a tech-gated unit or building the menu would not offer: a live
 *   generator/applier disagreement on the third gating dimension, and one no play test
 *   could surface while no shipped row declares `requiresTech`. It is closed — the
 *   planner asks this verdict and refuses with the typed `tech-required` naming the tech,
 *   and the exhaustive `GameError` renderers (`headless/src/repl.ts`,
 *   `testing/src/scenario.ts`) render it.
 *
 *   The **improvement** kind's one asker is `planStartWork` (`commands.ts`), which
 *   decides whether a worker may start — and it asks `unmetTechFor` on the improvement's
 *   own row, refusing with `improvement-tech-required`. So a tech-gated improvement
 *   cannot be started by a player who lacks the tech, and `unitActions` (which filters
 *   through that same evaluator) does not offer it either.
 *
 *   The *resource* dimension never needed such wiring, because it is enforced inside
 *   `connected`: a unit that requires a resource whose own row is locked behind an
 *   unknown tech is refused by `applyCommand` with the same typed
 *   `resource-not-connected` a missing road produces.
 * - **This module adds no numbers of its own.** Every yield comes from a catalog
 *   row (`ResourceDef.yields`), every path length is whatever the map has, and the
 *   only constants below are the zeros a tile starts from. Nothing here is a tuned
 *   value, so nothing here needs a provenance row; the *content* rows it reads are
 *   `placeholder` in `@civts/rules`, and no number of theirs is presented as
 *   Civ 3's.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O, no transcendentals,
 * and no floating-point arithmetic beyond `Number(tile)` on an integer. Every
 * function is a pure read of the state, the ruleset or both.
 */

// A runtime import of the building *rule*, and only its lookup: `buildingRow` is
// `buildings.ts`' one "find the row with this id", which `cities.ts`' `buildingDef`
// delegates to. It is imported from `buildings.ts` rather than from `cities.ts`
// because `cities.ts` imports *this* module at runtime (`tileYieldsWithResources`),
// so an edge back into it would be a cycle; `buildings.ts` is a leaf. The catalog
// itself is read off the view below, exactly as `tech.ts` reads it.
import { buildingRow } from './buildings.js';
import type { BuildingDef, ProductionItem } from './cities.js';
import type { PlayerId, ResourceId, TechId, TileIndex } from './ids.js';
import {
  improvementCatalog,
  improvementsAt,
  tileYields,
  type ImprovementId,
} from './improvements.js';
import {
  neighbors8,
  resourceDef,
  type ResourceDef,
  type RulesetView,
  type TerrainYields,
  type TileResource,
} from './map.js';
import type { GameState, PlayerState } from './state.js';
// Runtime import of the M5 tech *rule*, not of a copy of it: `requiresTechOf` is
// the one read of a row's `requiresTech` and `unmetTechRequirement` the one test of
// "does this player still need it?", and the gate below composes exactly those two.
// `tech.ts` imports this module not at all, so the edge is one-way.
import { requiresTechOf, unmetTechRequirement } from './tech.js';
import { unitDef } from './units.js';

/**
 * The delta a tile with no bonus resource gets: nothing, in every component.
 *
 * A shared frozen-by-convention object rather than a fresh literal per call, and
 * never handed out where a caller could write to it — every consumer below reads
 * it or builds a *new* object from it. It exists so "no bonus here" is one value
 * rather than three zeros repeated at each return.
 */
const NO_YIELDS: TerrainYields = { food: 0, shields: 0, commerce: 0 };

/**
 * Is this entry a `(tile, resource)` pair? The shape half of the read below, for
 * the same reason `improvements.ts` has one: a hand-edited save, or a state
 * written before M4c put `resources` on the map, can carry an array of anything,
 * and an entry that is not a pair names no tile.
 *
 * `'tile' in entry` narrows the object to a record with that key, so this needs
 * no cast to read the fields — the check *is* the narrowing.
 */
const isTileResource = (entry: unknown): entry is TileResource => {
  if (typeof entry !== 'object' || entry === null) return false;
  if (!('tile' in entry) || !('resource' in entry)) return false;
  return typeof entry.tile === 'number' && typeof entry.resource === 'string';
};

/**
 * The resource pairs a state's map carries, and the one place this module reads
 * `GameMap.resources`.
 *
 * On every map `generateWorld` or `newGame` produced this is the field, unchanged
 * and uncopied. The checks are for a map that did **not** come from this build —
 * a hand-built literal, a foreign object, a save written before M4c — and they
 * exist because of *where* a missing array would be noticed: `connected` is
 * called by production legality (`planSetProduction`), so a map without the field
 * would raise a `TypeError` inside a legality check, which is a far worse answer
 * than "this world holds no resources" and much worse to debug. Reading such a
 * state as carrying none is the only true thing to say about it, and it is the
 * same reading `improvements.ts`' `storedPairs` applies to its own field.
 */
const storedResources = (state: GameState): readonly TileResource[] => {
  const field: unknown = state.map.resources;
  if (!Array.isArray(field)) return [];
  // `Array.isArray` narrows to `any[]`, which would leak `any` into every read
  // below; `Array.from<unknown>` re-types it without a cast, and `filter` then
  // narrows each entry honestly.
  return Array.from<unknown>(field).filter(isTileResource);
};

/**
 * The player row `playerId` names, or `undefined` when the state holds none.
 *
 * The same linear scan `commands.ts`' `playerById` performs, kept local because the
 * two live in different layers: this module needs to know *that* a player exists
 * before asking anything about its techs or its cities, and one helper here is what
 * keeps `connected` and the M5 gate below from each writing their own `find`.
 */
const playerOf = (state: GameState, playerId: PlayerId): PlayerState | undefined =>
  state.players.find((candidate) => candidate.id === playerId);

/**
 * The improvement ids this ruleset calls a **road**: every catalog row whose
 * `kind` is `'road'`.
 *
 * A set read off the catalog rather than a constant `asImprovementId('road')`,
 * because the id is content's to choose — `@civts/rules` happens to name it
 * `road`, and nothing in the engine may depend on that. Roles and *kinds* are the
 * engine's vocabulary; ids are the catalog's.
 */
const roadKinds = (ruleset: RulesetView): ReadonlySet<ImprovementId> => {
  const kinds = new Set<ImprovementId>();
  for (const def of improvementCatalog(ruleset)) {
    if (def.kind === 'road') kinds.add(def.id);
  }
  return kinds;
};

/** Does `tile` carry an improvement this ruleset calls a road? */
const isRoadTile = (
  state: GameState,
  tile: TileIndex,
  roads: ReadonlySet<ImprovementId>,
): boolean => improvementsAt(state, tile).some((kind) => roads.has(kind));

/**
 * Every tile reachable from `centres` by an 8-way path of road-improved tiles,
 * with the centres themselves included as path tiles whatever they carry.
 *
 * The walk is a breadth-first search over a *set*, not a scoring or shortest-path
 * computation: the question is only "is there any path at all", so the first time
 * a tile is reached is the only time it matters, and there is no distance to
 * compare. The queue is an array walked by index rather than `shift()`ed (which
 * would be quadratic on a long road), and neighbours come from `neighbors8`, whose
 * order is a property of the map's dimensions — so the same state always produces
 * the same visit order, and therefore the same `reached` set. No path length limit
 * is applied, per the contract: a road across the whole map connects its ends.
 *
 * The centres are seeded first, in `centres` order, and the set that comes out
 * holds the same tiles whichever city the caller listed first: membership cannot
 * depend on visit order, only on whether *some* walk reached the tile.
 */
const reachableTiles = (
  state: GameState,
  centres: readonly TileIndex[],
  roads: ReadonlySet<ImprovementId>,
): ReadonlySet<number> => {
  const reached = new Set<number>();
  const queue: number[] = [];

  for (const centre of centres) {
    const index = Number(centre);
    if (reached.has(index)) continue;
    reached.add(index);
    queue.push(index);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue; // unreachable: `head < queue.length`
    for (const neighbour of neighbors8(state.map, current)) {
      const index = Number(neighbour);
      if (reached.has(index)) continue;
      // The *interior* of a path must be road: this is the rule that makes a gap
      // in a chain break the connection, and it is stated once, here.
      if (!isRoadTile(state, neighbour, roads)) continue;
      reached.add(index);
      queue.push(index);
    }
  }

  return reached;
};

/**
 * Every resource **connected** for `playerId` — the one implementation of M4c's
 * connection rule (see the module note for the sentence it encodes).
 *
 * The walk: seed an 8-way breadth-first search with every city centre the player
 * owns, expand through road-improved tiles, then read the map's resource pairs:
 * a resource is connected when its tile was reached, or when it is 8-way adjacent
 * to a reached tile — the "endpoints inclusive" half of the contract, which is
 * what lets a road chain stop *beside* the resource it connects. Note what the
 * second half says for the shortest case: a resource next to a city centre is
 * connected with no road anywhere, because a one-step path has no interior to
 * improve. That is the contract's rule and not an accident of this walk, and
 * `isConnected` is the only thing callers should ask.
 *
 * Answers with an **empty set** — not `undefined`, not a throw — for a player the
 * state does not hold, for a barbarian (no economy, no connections), and for a
 * civilization with no city (nothing to walk from). Those are three different
 * reasons for the same true answer, and every caller wants "nothing connected"
 * rather than a failure channel it would have to invent.
 *
 * Since M5 it also answers with nothing for a resource whose own row declares a
 * `requiresTech` this player does not know: the resource is not *connectable* yet,
 * whatever the roads say (see the module note, and `unmetTechFor` below, which is
 * the read that decides it). That is one clause inside this single walk rather than
 * a second "is it unlocked?" question asked by each consumer, which is what keeps
 * two answers to one question from existing at all.
 *
 * The result is a `Set<ResourceId>`, which is what the frozen signature asks for:
 * membership is the question every consumer actually has (`isConnected`,
 * `resourceGate`), and a set cannot report the same resource twice when two roads
 * reach it — the "same resource reachable via two paths" case, which is a
 * connection, not a double connection.
 *
 * Deterministic: the set's insertion order follows `map.resources`, which
 * `map.ts` fixes as `(tile, resource)` ascending, and the walk itself writes only
 * into a set whose contents cannot depend on visit order.
 */
export const connected = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): ReadonlySet<ResourceId> => {
  const result = new Set<ResourceId>();

  const player = playerOf(state, playerId);
  if (player === undefined || player.kind === 'barbarian') return result;

  const centres: TileIndex[] = [];
  for (const city of state.cities) {
    if (city.owner === playerId) centres.push(city.tile);
  }
  if (centres.length === 0) return result;

  const reached = reachableTiles(state, centres, roadKinds(ruleset));

  for (const entry of storedResources(state)) {
    // M5: a row that demands a tech this player has not researched is not
    // connectable, so it is not connected — no matter how good the road is. The
    // rule asked here is `tech.ts`' `unmetTechRequirement` through `unmetTech`, not a
    // second test written here, and the player is already resolved above.
    if (unmetTech(player, requiresTechOf(resourceDef(ruleset, entry.resource))) !== undefined) {
      continue;
    }

    if (reached.has(Number(entry.tile))) {
      result.add(entry.resource);
      continue;
    }
    const touchesRoad = neighbors8(state.map, Number(entry.tile)).some((neighbour) =>
      reached.has(Number(neighbour)),
    );
    if (touchesRoad) result.add(entry.resource);
  }

  return result;
};

/**
 * Is `resource` connected for `playerId`? The membership question, asked of the
 * one implementation above — sugar, not a second rule, so a caller that wants a
 * boolean never grows its own walk.
 */
export const isConnected = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  resource: ResourceId,
): boolean => connected(state, ruleset, playerId).has(resource);

/**
 * The resource a production item's row demands, or `undefined` when it demands
 * none.
 *
 * This is the **only** read of `UnitDef.requiresResource` in the engine, which is
 * why it is exported: a UI that wants to render "requires iron" and the gate below
 * must be looking at the same field with the same meaning, and a second
 * `def.requiresResource` somewhere else is a second answer to "what does this unit
 * need".
 *
 * Buildings demand nothing in M4c: the frozen `BuildingEffect` union has no
 * resource member, so a building item always answers `undefined` here rather than
 * being looked up and found empty.
 */
export const requiredResourceOf = (
  ruleset: RulesetView,
  item: ProductionItem,
): ResourceId | undefined =>
  item.kind === 'unit' ? unitDef(ruleset, item.id)?.requiresResource : undefined;

/**
 * The verdict on whether `playerId` may build `item`: **open**, or **blocked** by a
 * named resource.
 *
 * A two-member union rather than a boolean, because the caller has to be able to
 * say *which* resource is missing — the typed refusal in `commands.ts` carries it,
 * and a `false` would leave the UI with nothing to render. `open` covers both
 * "nothing is required" and "required and connected" deliberately: the two are the
 * same answer to the only question a caller has, and distinguishing them would
 * invite a caller to treat "no requirement" as a third state it must handle.
 *
 * The gate is the player's (see the module note): `connected` is asked about
 * `playerId`, so a requirement is satisfied by *any* of the player's roads
 * reaching the resource, not only by the city doing the building.
 *
 * A `requiresResource` naming an id no catalog row defines is simply not connected
 * unless the map happens to carry that id reachably — a state only a hand-built
 * map can reach, since `validateRuleset` rejects such a unit row outright
 * (`packages/rules`: "every `requiresResource` a unit declares must name a
 * resource this catalog defines"). This function does not re-check the catalog:
 * that check belongs to validation, and re-stating it here would be a second
 * opinion about what a ruleset may contain.
 */
export type ResourceGate =
  { readonly kind: 'open' } | { readonly kind: 'blocked'; readonly resource: ResourceId };

export const resourceGate = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  item: ProductionItem,
): ResourceGate => {
  const required = requiredResourceOf(ruleset, item);
  if (required === undefined) return { kind: 'open' };
  return connected(state, ruleset, playerId).has(required)
    ? { kind: 'open' }
    : { kind: 'blocked', resource: required };
};

/* ------------------------------------------------------------------ *
 * M5 gating — `requiresTech`, beside the resource gate
 * ------------------------------------------------------------------ */

/**
 * The missing tech for a player and an **already-read** requirement: `undefined` when
 * nothing is required or the player knows it, the id otherwise.
 *
 * This is the one place the two special cases of an id-keyed read are decided, and
 * both are decided the same way `connected` decides the missing-player case — by
 * answering what is true rather than by failing:
 *
 * - **a row that declares nothing** needs nothing, whoever is asking;
 * - **a player the state does not hold knows no techs**, so a requirement it cannot
 *   be shown to have researched is reported as missing rather than as satisfied. That
 *   also covers the barbarians, who never research (their `techs` is empty), which is
 *   the same "no economy, no connections" answer M4c gives them.
 *
 * Everything else — what the field is, and whether a player satisfies it — is
 * `tech.ts`', inherited through `requiresTechOf` and `unmetTechRequirement` rather
 * than reimplemented: the absent-player branch above is a *totality* decision about
 * an id this state cannot resolve, not a second reading of "knows the tech".
 */
const unmetTech = (
  player: PlayerState | undefined,
  required: TechId | undefined,
): TechId | undefined => {
  if (required === undefined) return undefined;
  if (player === undefined) return required;
  return unmetTechRequirement(player, required);
};

/**
 * The tech `playerId` still needs before `row` becomes available, or `undefined`.
 *
 * The generic, player-resolving form: any spec row of any of the four kinds M5's
 * gating section names — a unit row, a building row, an improvement row, a resource
 * row — asked for one player. A caller that already resolved its row (an
 * improvement through `improvementDef`, a resource through `resourceDef`) passes it
 * straight in, which is what keeps "which tech does this need?" from being answered
 * by each spec kind separately.
 *
 * A row that is not an object, or whose `requiresTech` is not a string, requires
 * nothing: that is `requiresTechOf`'s judgement, inherited rather than restated, and
 * it is the honest answer — a requirement this engine cannot name is not one it can
 * check.
 */
export const unmetTechFor = (
  state: GameState,
  playerId: PlayerId,
  row: unknown,
): TechId | undefined => unmetTech(playerOf(state, playerId), requiresTechOf(row));

/**
 * The building catalog of a view, read the way `tech.ts` reads it: a view without
 * the optional field ships no rows.
 *
 * Not `cities.ts`' `buildingCatalog`, and the reason is mechanical rather than
 * editorial: `cities.ts` imports *this* module at runtime
 * (`tileYieldsWithResources`), so importing it back would make a cycle, and this
 * module's whole job is to stay a leaf of the graph that anything may ask. The
 * judgement is the same one that function makes — no field, no buildings — and the
 * lookup of a row within it is `buildings.ts`' `buildingRow`, which `cities.ts`
 * delegates to, so "find the row with this id" still has one implementation.
 */
const buildingRowsOf = (ruleset: RulesetView): readonly BuildingDef[] => ruleset.buildings ?? [];

/**
 * The tech a **production item's own row** declares, or `undefined` when the row
 * declares none (or this ruleset defines no such row).
 *
 * The row is resolved once, here, for both kinds of item — a unit through `unitDef`,
 * a building through the catalog lookup above — so `requiresTech` and
 * `requiresResource` are read off the same row rather than each growing its own
 * resolution. Buildings are included deliberately, unlike `requiredResourceOf`: M5's
 * gating section names buildings, and nothing in `BuildingEffect` is involved — the
 * field is on the row, not in the effects union.
 */
export const requiredTechOf = (ruleset: RulesetView, item: ProductionItem): TechId | undefined => {
  const row =
    item.kind === 'unit'
      ? unitDef(ruleset, item.id)
      : buildingRow(buildingRowsOf(ruleset), item.id);
  return requiresTechOf(row);
};

/**
 * The tech `playerId` still needs before `item` may be built at all, or `undefined`.
 *
 * There are exactly two ways a production item can be tech-gated, and both are
 * named here because both are facts about the *item* rather than about the city
 * doing the building:
 *
 * 1. **the item's own row declares `requiresTech`** — a swordsman that needs Iron
 *    Working. `tech.ts`' rule decides it, so a player who has researched it is not
 *    gated.
 * 2. **the item declares none, but the resource it requires does.** A unit that
 *    needs iron, where iron itself becomes connectable only once a tech is known,
 *    is unbuildable for that player however many roads it has. Answering "nothing is
 *    missing" there would be false, and it is exactly the case a reader is most
 *    likely to miss.
 *
 * The item's own requirement is asked first, so when both are unmet the reported
 * tech is the closer cause. Neither branch is a second rule: both are
 * `tech.ts`' `unmetTechRequirement`, the first reading the item's row and the second
 * the row of the resource the item requires.
 */
export const unmetItemTech = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  item: ProductionItem,
): TechId | undefined => {
  const player = playerOf(state, playerId);

  const own = requiredTechOf(ruleset, item);
  if (own !== undefined) return unmetTech(player, own);

  const resource = requiredResourceOf(ruleset, item);
  if (resource === undefined) return undefined;
  return unmetTech(player, requiresTechOf(resourceDef(ruleset, resource)));
};

/**
 * The verdict on whether `playerId` may build `item` — **the third gating dimension,
 * stated in the same place as the second**.
 *
 * M4c decided availability with one verdict, `ResourceGate`, because a boolean would
 * leave the caller unable to say *which* resource was missing. M5 adds a second way
 * to be unavailable, so the verdict gains a second member rather than a second
 * function: `tech-required` **names the tech**, which is the whole reason it is a
 * member and not a reused `blocked` — "research Bronze Working" and "connect iron"
 * are different instructions, and a caller (the AI ranking choices, the UI greying a
 * button, the typed refusal in `commands.ts`) has to be able to tell them apart
 * without parsing prose.
 *
 * **Order, and it is observable: the tech is asked first.** When an item is both
 * tech-gated and resource-blocked, the resource is usually blocked *because* of the
 * tech (see `unmetItemTech`'s second branch), so naming the tech names the cause a
 * player can act on. The two are never both reported: one verdict answers one
 * command.
 *
 * `resourceGate` is still the resource half and is asked here rather than restated,
 * so M4c's connection rule keeps its one implementation and a `blocked` verdict
 * means exactly what it meant before M5.
 */
export type ProductionGate =
  | { readonly kind: 'open' }
  | { readonly kind: 'tech-required'; readonly tech: TechId }
  | { readonly kind: 'blocked'; readonly resource: ResourceId };

/**
 * May `playerId` build `item`? The one gate for a production item's availability,
 * and the function a planner and an applier are both meant to ask — that is what
 * makes "the generator and the applier cannot disagree" true by construction rather
 * than by review (see the wiring note in the module doc: `planSetProduction` asks
 * `resourceGate` alone today).
 *
 * The result is a plain data verdict, so it is as hashable, loggable and testable as
 * anything else in the engine, and a caller that only wants a boolean asks
 * `.kind === 'open'` — the same reading `ResourceGate` has always had.
 */
export const productionGate = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  item: ProductionItem,
): ProductionGate => {
  const tech = unmetItemTech(state, ruleset, playerId, item);
  if (tech !== undefined) return { kind: 'tech-required', tech };
  return resourceGate(state, ruleset, playerId, item);
};

/**
 * The yields `tile` gains from the resources on it: the sum of every **bonus**
 * row's `yields`, and nothing at all for a strategic or luxury one.
 *
 * - **On top of terrain and improvements**, never instead of them: this is a
 *   *delta*, exactly like an improvement's, and `tileYieldsWithResources` below is
 *   where the three are added together.
 * - **A tile carries at most one resource** (`map.ts`: "at most one resource per
 *   tile", which `generateWorld` enforces), so the sum is normally one row. It is
 *   written as a sum anyway because a hand-built map is not bound by the
 *   generator's rule, and a read that silently used only the first pair would make
 *   the second one invisible rather than harmless.
 * - **Not gated and not connected** (M4c: "they are just terrain"). A bonus
 *   resource feeds a city whether or not a road reaches it, and this function
 *   never asks `connected` — a call to the connection rule here would be the
 *   clearest possible way to contradict the contract.
 * - **An id no catalog row defines contributes nothing**, and so does a row whose
 *   kind is not `bonus`: the state is read as it is, and a ruleset that cannot
 *   describe what is on a tile cannot claim it yields anything.
 * - **Integer addition only** (PLAN.md §5.3).
 */
export const bonusYieldsAt = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): TerrainYields => {
  let food = 0;
  let shields = 0;
  let commerce = 0;
  let applied = false;

  for (const entry of storedResources(state)) {
    if (entry.tile !== tile) continue;
    const def: ResourceDef | undefined = resourceDef(ruleset, entry.resource);
    if (def === undefined || def.kind !== 'bonus') continue;
    food += def.yields.food;
    shields += def.yields.shields;
    commerce += def.yields.commerce;
    applied = true;
  }

  // The shared zero object is handed back only when there is nothing to add, and
  // it is never a value a caller may write to: `TerrainYields` is readonly, and
  // every branch that adds anything builds a fresh object.
  return applied ? { food, shields, commerce } : NO_YIELDS;
};

/**
 * What `tile` is worth in `state`: its terrain yields, plus every improvement's
 * delta, plus every bonus resource's delta — or `undefined` when the tile is off
 * the map or its terrain id is not in this ruleset.
 *
 * The composition, and the only one: the terrain-plus-improvements half is
 * `improvements.ts`' `tileYields` (this module does not re-walk the improvement
 * list, and must never grow a second copy of that rule), and the resource half is
 * `bonusYieldsAt` above. A caller that wants "what is this tile worth now?" —
 * `cityYields` for a worked tile, a citizen-assignment ranking, a tooltip, a test
 * — asks this rather than adding the two itself, so the sum has one statement.
 *
 * Clamped at zero per component, like the improvement sum it builds on: the
 * shipped validator rejects a negative `yields` on any row (`@civts/rules`
 * `checkResource`), but a foreign or hand-built catalog can still carry one, and a
 * negative total is a value that would reach a hashed city yield. The clamp is
 * defence against an undescribed row, not a resource rule.
 */
export const tileYieldsWithResources = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): TerrainYields | undefined => {
  const base = tileYields(state, ruleset, tile);
  if (base === undefined) return undefined;

  const bonus = bonusYieldsAt(state, ruleset, tile);
  return {
    food: Math.max(0, base.food + bonus.food),
    shields: Math.max(0, base.shields + bonus.shields),
    commerce: Math.max(0, base.commerce + bonus.commerce),
  };
};
