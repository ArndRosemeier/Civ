/**
 * Event rendering — **one real line for every member of the engine's `GameEvent`
 * union**, and a line that says something for each of them.
 * See docs/INTERFACES.md, M8 ("A4 coverage" — the event log) and M2/M3/M4a/M4b/M5/M6
 * for the event members themselves.
 *
 * ## Why this module exists, and why the exhaustiveness is the point
 *
 * The UI may not re-derive what happened (PLAN.md §5.4: "the UI receives events, not 16k
 * tiles per turn"), so the log is a rendering of the engine's own `GameEvent` values and
 * nothing else. That makes this file a *consumer of a frozen union*, and a consumer of an
 * exhaustive union has exactly one failure mode that matters: a member nobody rendered.
 * This project has already shipped that bug once — an unhandled event produced a silently
 * blank line, which looks identical to "nothing happened" — so the renderer is written so
 * that the failure cannot be silent:
 *
 * - the `switch` has **no `default` clause**, so adding a member to `GameEvent` breaks the
 *   switch's exhaustiveness and the *typechecker* fails this file;
 * - the statement after the switch passes the (now `never`) event to `assertNever`, which
 *   throws if it is ever reached at runtime. A cast, an `any`, or an `as` here would be the
 *   silence this file exists to remove, and there is none.
 *
 * ## Names come from the engine, never from a second table
 *
 * Every id an event carries is resolved through the engine's own reader: `unitById`,
 * `unitDef`, `cityById`, `techDef`, `improvementDef`, `buildingDef`, and the player list on
 * the state. Nothing here keeps a name table of its own — a second mapping from an id to a
 * name is a second answer to "what is this called", free to disagree with the engine's.
 * A miss is rendered honestly rather than thrown away: an unknown unit prints as
 * `unit 7`, an unknown tech as its raw id, which is the same reading the REPL takes.
 *
 * ## State at render time, and why that is stated rather than assumed
 *
 * A line is rendered **when the event is emitted**, against the state the command
 * produced. That is what makes `unitLabel` able to name a unit that no longer exists
 * afterwards, and it is why `renderEvent` takes the state rather than a snapshot of
 * names taken before the command: the log is written forward in time, and a later refresh
 * must not rewrite history. Nothing in this module reads the clock, the DOM or randomness;
 * it is a pure function of `(event, state, ruleset)`, which is what lets the fast vitest
 * tier test every member in Node.
 */

import {
  buildingDef,
  cityById,
  improvementDef,
  indexToX,
  indexToY,
  techDef,
  unitById,
  unitDef,
  type BuildingId,
  type CityId,
  type GameEvent,
  type GameMap,
  type GameState,
  type HutRewardKind,
  type ImprovementId,
  type PlayerId,
  type ProductionItem,
  type ResourceId,
  type RulesetView,
  type TechId,
  type TileIndex,
  type UnitDestroyedReason,
  type UnitId,
  type UnitTypeId,
  type WorkCancelledReason,
} from '@civts/core';

/**
 * The exhaustiveness check every switch in this file ends on: it accepts **only**
 * `never`, so it compiles exactly when the switch above it has handled every member of
 * the union, and throws if a value ever reaches it anyway (an event that arrived from
 * outside this build — a save file, a foreign ruleset's game, a future version of the
 * engine talking to an older page).
 *
 * Exported because the panels end their own switches on it (`unitpanel.ts` on `Command`,
 * this module on the five unions the events carry). One implementation, so "unhandled
 * case" is one message rather than one per file.
 */
export const assertNever = (value: never): never => {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
};

/** The state and ruleset a line is rendered against — see the module note on the moment. */
export interface EventContext {
  readonly state: GameState;
  readonly ruleset: RulesetView;
}

/** `x,y` for a tile index — derived, never stored (`map.ts`), so the two cannot drift. */
export const tileLabel = (map: GameMap, tile: TileIndex): string =>
  `${String(indexToX(map, tile))},${String(indexToY(map, tile))}`;

/** A player's name, or `player <id>` when the state does not define that id. */
const playerLabel = (state: GameState, id: PlayerId): string =>
  state.players.find((player) => player.id === id)?.name ?? `player ${String(id)}`;

/** A city's name, or `city <id>`. */
const cityLabel = (state: GameState, id: CityId): string =>
  cityById(state, id)?.name ?? `city ${String(id)}`;

/**
 * A unit as a line names it: its type's name and its id (`Settler 0`), or `unit <id>`
 * when the unit is not in the state any more. The id is always on the line because the
 * id is what a command names, so a reader can act on what the log told them.
 */
const unitLabel = (state: GameState, ruleset: RulesetView, id: UnitId): string => {
  const unit = unitById(state, id);
  if (unit === undefined) return `unit ${String(id)}`;
  const def = unitDef(ruleset, unit.type);
  return `${def?.name ?? unit.type} ${String(id)}`;
};

/** A unit *type*'s name (`Horseman`), or the raw id — used where no unit is named. */
const unitTypeLabel = (ruleset: RulesetView, type: UnitTypeId): string =>
  unitDef(ruleset, type)?.name ?? type;

/** An improvement's name, or the raw id. */
const improvementLabel = (ruleset: RulesetView, kind: ImprovementId): string =>
  improvementDef(ruleset, kind)?.name ?? kind;

/** A building's name, or the raw id. */
const buildingLabel = (ruleset: RulesetView, id: BuildingId): string =>
  buildingDef(ruleset, id)?.name ?? id;

/** A tech's name, or the raw id. */
const techLabel = (ruleset: RulesetView, id: TechId): string => techDef(ruleset, id)?.name ?? id;

/** A resource's name, or the raw id. */
const resourceLabel = (ruleset: RulesetView, id: ResourceId): string =>
  (ruleset.resources ?? []).find((resource) => resource.id === id)?.name ?? id;

/**
 * A production item as this package names it: `Settler (unit)` / `Granary (building)`.
 *
 * The kind is spelled out because `{ kind: 'unit', id: 'x' }` and
 * `{ kind: 'building', id: 'x' }` are different things that may share a name — the reason
 * `ProductionItem` is a tagged union at all (`cities.ts`) — and a line that dropped the
 * tag would make two distinct facts read the same.
 *
 * Exported because the event log, the city screen's production menu and the city screen's
 * queue all name an item; one spelling, so "the same item" cannot read as two.
 */
export const productionItemName = (ruleset: RulesetView, item: ProductionItem): string =>
  item.kind === 'unit'
    ? `${unitTypeLabel(ruleset, item.id)} (unit)`
    : `${buildingLabel(ruleset, item.id)} (building)`;

/** Why a job ended, as prose; exhaustive over `WorkCancelledReason`. */
const cancelledReasonLabel = (reason: WorkCancelledReason): string => {
  switch (reason) {
    case 'cancelled':
      return 'cancelled';
    case 'moved':
      return 'the unit moved away';
  }
  return assertNever(reason);
};

/** Why a unit left the world, as prose; exhaustive over `UnitDestroyedReason`. */
const destroyedReasonLabel = (reason: UnitDestroyedReason): string => {
  switch (reason) {
    case 'combat':
      return 'destroyed in combat';
    case 'bankruptcy':
      return 'disbanded for want of gold';
  }
  return assertNever(reason);
};

/**
 * What a hut gave, as prose; exhaustive over `HUT_REWARD_KINDS`.
 *
 * `unitGiven` is the free unit's id for the `unit` reward and is **absent** for the other
 * two (M3's event note: never a key holding `undefined`), so the branch that needs it asks
 * for it and the other two do not. `nothing` is a reward the player actually received — a
 * spent hut is spent (M3) — so it gets a line rather than silence, which is exactly the
 * distinction a blank renderer would erase.
 */
const hutRewardLabel = (
  reward: HutRewardKind,
  unitGiven: UnitId | undefined,
  state: GameState,
  ruleset: RulesetView,
): string => {
  switch (reward) {
    case 'unit':
      return unitGiven === undefined
        ? 'a free unit (which the state no longer holds)'
        : `a free ${unitLabel(state, ruleset, unitGiven)}`;
    case 'barbarians':
      return 'a band of barbarians';
    case 'nothing':
      return 'nothing';
  }
  return assertNever(reward);
};

/**
 * One line for one event. Total over `GameEvent`, and the switch is the union's own
 * member list — see the module note on why there is no `default`.
 */
const renderEvent = (event: GameEvent, ctx: EventContext): string => {
  const { state, ruleset } = ctx;
  const map = state.map;

  switch (event.type) {
    case 'UnitMoved':
      return `${unitLabel(state, ruleset, event.unitId)} moved ${tileLabel(map, event.from)} → ${tileLabel(map, event.to)} (cost ${String(event.cost)}, ${String(event.movementLeft)} movement left)`;
    case 'TurnEnded':
      return `Turn ${String(event.turn)}: ${playerLabel(state, event.playerId)} ended the turn`;
    case 'CityFounded':
      return `${playerLabel(state, event.owner)} founded ${event.name} at ${tileLabel(map, event.tile)}`;
    case 'CityGrew':
      return `${cityLabel(state, event.cityId)} grew to ${String(event.population)} (food box ${String(event.foodBox)})`;
    case 'CityStarved':
      return `${cityLabel(state, event.cityId)} starved to ${String(event.population)} (food box ${String(event.foodBox)})`;
    case 'CityProduced': {
      const where =
        event.unitId === undefined || event.tile === undefined
          ? ''
          : ` — ${unitLabel(state, ruleset, event.unitId)} appeared at ${tileLabel(map, event.tile)}`;
      return `${cityLabel(state, event.cityId)} produced ${productionItemName(ruleset, event.item)} (${String(event.shields)} shields left)${where}`;
    }
    case 'HutEntered':
      return `${unitLabel(state, ruleset, event.unitId)} entered a hut at ${tileLabel(map, event.tile)}: ${hutRewardLabel(event.reward, event.unitGiven, state, ruleset)}`;
    case 'BarbariansSpawned': {
      const names = event.unitIds.map((id) => unitLabel(state, ruleset, id));
      return `${playerLabel(state, event.owner)} spawned ${String(names.length)} barbarians from the hut at ${tileLabel(map, event.tile)}: ${names.join(', ')}`;
    }
    case 'WorkStarted':
      return `${unitLabel(state, ruleset, event.unitId)} started ${improvementLabel(ruleset, event.kind)} at ${tileLabel(map, event.tile)} (${String(event.turnsLeft)} turns)`;
    case 'WorkCancelled':
      return `${unitLabel(state, ruleset, event.unitId)} stopped ${improvementLabel(ruleset, event.kind)} at ${tileLabel(map, event.tile)}: ${cancelledReasonLabel(event.reason)}, ${String(event.turnsLeft)} turns abandoned`;
    case 'WorkCompleted':
      return `${unitLabel(state, ruleset, event.unitId)} completed ${improvementLabel(ruleset, event.kind)} at ${tileLabel(map, event.tile)}`;
    case 'IncomeCollected':
      return `${playerLabel(state, event.playerId)} collected ${String(event.gold)} gold, ${String(event.beakers)} beakers, ${String(event.luxuries)} luxuries`;
    case 'UpkeepPaid':
      return `${playerLabel(state, event.playerId)} paid ${String(event.gold)} upkeep (maintenance ${String(event.maintenance)}, unit support ${String(event.unitSupport)} for ${String(event.units)} units, ${String(event.freeUnits)} free)`;
    case 'UnitDisbanded':
      return `${playerLabel(state, event.playerId)} disbanded ${unitTypeLabel(ruleset, event.unitType)} ${String(event.unitId)} at ${tileLabel(map, event.tile)} (saved ${String(event.saved)} gold)`;
    case 'TreasuryShortfall':
      return `${playerLabel(state, event.playerId)} could not pay ${String(event.unpaid)} gold of upkeep`;
    case 'TechResearched':
      return `${playerLabel(state, event.playerId)} researched ${techLabel(ruleset, event.tech)} (${String(event.cost)} beakers, ${String(event.beakers)} left)`;
    case 'CombatResolved': {
      const outcome = event.outcome === 'attacker-wins' ? 'the attacker won' : 'the defender held';
      return `${unitLabel(state, ruleset, event.attackerId)} attacked ${unitLabel(state, ruleset, event.defenderId)} at ${tileLabel(map, event.target)}: ${outcome} in ${String(event.rounds)} rounds (${String(event.attackerWinPct)}% per round, attacker lost ${String(event.attackerLost)} hp, defender lost ${String(event.defenderLost)} hp)`;
    }
    case 'UnitDestroyed': {
      const killer =
        event.byUnitId === undefined ? '' : ` by ${unitLabel(state, ruleset, event.byUnitId)}`;
      return `${unitTypeLabel(ruleset, event.unitType)} ${String(event.unitId)} of ${playerLabel(state, event.owner)} was ${destroyedReasonLabel(event.reason)} at ${tileLabel(map, event.tile)}${killer}`;
    }
    case 'UnitPromoted':
      return `${unitLabel(state, ruleset, event.unitId)} was promoted to level ${String(event.experience)} of ${String(event.maxExperience)} at ${tileLabel(map, event.tile)}`;
    case 'CityCaptured': {
      const sacked =
        event.destroyed.length === 0
          ? ''
          : `, sacked: ${event.destroyed.map((id) => buildingLabel(ruleset, id)).join(', ')}`;
      return `${playerLabel(state, event.to)} captured ${event.name} (city ${String(event.cityId)}) from ${playerLabel(state, event.from)} at ${tileLabel(map, event.tile)} — population ${String(event.population)}${sacked}`;
    }
  }

  // Unreachable while the switch above handles every member: the type of `event` is
  // `never` here, which is what makes adding a `GameEvent` member a compile error in this
  // file rather than a blank line in the log. See the module note.
  return assertNever(event);
};

/** One log line for one event. */
export const eventLine = (event: GameEvent, ctx: EventContext): string => renderEvent(event, ctx);

/** One log line per event, in order — what the log appends for a command's outcome. */
export const eventLines = (events: readonly GameEvent[], ctx: EventContext): readonly string[] =>
  events.map((event) => renderEvent(event, ctx));

/**
 * A resource an event might name, rendered through the engine's catalog — kept exported
 * because the debug panel lists a player's connected resources with the same spelling, and
 * two spellings of one name is the drift this module exists to avoid.
 */
export const resourceName = (ruleset: RulesetView, id: ResourceId): string =>
  resourceLabel(ruleset, id);

/** A tech's name as the log spells it, for the tech-tree panel's own labels. */
export const techName = (ruleset: RulesetView, id: TechId): string => techLabel(ruleset, id);

/** A city's name as the log spells it, for the city list and the city screen's title. */
export const cityName = (state: GameState, id: CityId): string => cityLabel(state, id);

/** A unit's name as the log spells it (`Settler 0`), for the unit panel's list. */
export const unitName = (state: GameState, ruleset: RulesetView, id: UnitId): string =>
  unitLabel(state, ruleset, id);
