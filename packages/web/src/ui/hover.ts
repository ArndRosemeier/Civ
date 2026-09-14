/**
 * `hover.ts` — **THE HOVER LAYER**: what the tile under the pointer is worth, what it would cost,
 * and what would happen if the selected unit attacked something on it.
 *
 * `docs/UI-OVERHAUL.md` §7.6 phase 6 and §2.E rule 5: *"Information is not chrome. Tile yields,
 * movement cost and combat odds surface on hover, where the pointer already is."*
 *
 * ------------------------------------------------------------------ *
 * The trap this module exists to avoid
 * ------------------------------------------------------------------ *
 *
 * The plan names it twice (§4.4b, §7.6): a hover readout is one bad decision away from being **a
 * second statement of the rules**. Every number here is therefore a *read of an engine function*,
 * and this file contains no arithmetic over game quantities at all:
 *
 * | the question | who answers it | what this file does |
 * |---|---|---|
 * | what does this tile yield? | `tileYields` (`improvements.ts`) | prints the three numbers |
 * | may the selected unit step here, and at what cost? | `planMove` (`commands.ts`) | prints `cost`/`movementLeft`, or the engine's refusal |
 * | how far away is it, if not adjacent? | `planRoute` (`route.ts`) | prints the step count, or the engine's refusal |
 * | what would an attack here do? | `applyCommand` on a **copy**, read for the `CombatResolved` event the engine emitted | prints `attackerWinPct`, verbatim |
 * | is this tile known / seen now? | `isExplored` / `visibleTiles` (`fog.ts`) | decides whether to say anything at all |
 *
 * The last row is the only place this file makes a *decision*, and it is a decision about fog rather
 * than about a rule: terrain and yields are **memory** (`isExplored`), because `render.ts` already
 * paints an explored tile's terrain and the border tint from memory; a unit is **current sight**
 * (`visibleTiles`), because a unit marker is a claim about what the player can see this instant —
 * the split `docs/UI-OVERHAUL.md` §7.8 settled for the renderer and `KNOWN-ISSUES.md` §3.13 records,
 * asked of the same two functions so a readout cannot leak what the map does not show.
 *
 * ------------------------------------------------------------------ *
 * Combat odds: the engine has no odds *query*, and this is what it has instead
 * ------------------------------------------------------------------ *
 *
 * There is no exported function that answers "what are the odds of this unit attacking that one".
 * `combat.ts` exports `resolveCombat` (which fights a battle from a **fully built** `CombatContext`)
 * and the modifier helpers, but the construction of that context — both units' statistics, the
 * defender's terrain, fortification, city and wall bonuses — lives inside `applyBattle`
 * (`commands.ts`), which is not exported. Building it here would mean this package deciding which
 * bonuses apply, i.e. exactly the second rules implementation the brief forbids.
 *
 * So the odds are obtained the way the AI obtains them (`packages/sim/src/ai/smart.ts`, M6's
 * assault read): **the engine's own offered `AttackUnit` command is folded through `applyCommand` on
 * a copy of the state, and the `CombatResolved` event it emits is read for `attackerWinPct`.** That
 * number is produced by `resolveCombat` inside the engine, on the real state, through the real
 * applier — the same call that would run if the player clicked. The copy is discarded; the
 * simulation's state and RNG are untouched, so the readout cannot change the game.
 *
 * What that gives is the engine's **per round** chance, and the readout says "per round" because
 * that is what the engine computes. It is *not* the chance of winning the whole battle, which no
 * engine function returns: the AI's own multi-round model (`battleWinPctOf`) is private to
 * `packages/sim`. A readout that multiplied the per round figure by the hit points would be this
 * package inventing a probability, and it is deliberately not done — see §9 of the plan, where the
 * gap is recorded rather than papered over.
 */

import {
  applyCommand,
  improvementDef,
  improvementsAt,
  indexToX,
  indexToY,
  isExplored,
  planAttackUnit,
  planMove,
  planRoute,
  tileYields,
  unitActions,
  unitDef,
  visibleTiles,
  type Command,
  type GameState,
  type GameEvent,
  type PlayerId,
  type RulesetView,
  type TerrainYields,
  type TileIndex,
  type UnitId,
  type UnitTypeId,
} from '@civts/core';
import { problemText } from './problem.js';

/** What the selected unit would spend, or why the engine will not let it move there. */
export type MovementReadout =
  /** The engine's own `MovePlan`: what the step costs and what is left afterwards. */
  | { readonly kind: 'cost'; readonly cost: number; readonly movementLeft: number }
  /** Not a single step, but the engine's route query found a way: how many steps it is. */
  | { readonly kind: 'route'; readonly steps: number }
  /** The engine refuses it, in the engine's own words. */
  | { readonly kind: 'refused'; readonly reason: string };

/** What an attack on this tile would be, from the engine's own answer. */
export type CombatReadout =
  /** The engine's per round win chance for the attacker, read off its own `CombatResolved`. */
  | { readonly kind: 'odds'; readonly perRoundPct: number }
  /** An undefended enemy city: the engine captures it, so there is no battle to price. */
  | { readonly kind: 'capture' }
  /** The engine refuses the attack — usually movement, sometimes the target. */
  | { readonly kind: 'refused'; readonly reason: string };

/** Everything the readout says about one tile, as data — the text is assembled from this. */
export interface TileReadout {
  /** The tile, in the map's own coordinates: what the player reads and what a test asserts. */
  readonly x: number;
  readonly y: number;
  /** Has this player ever seen it (`isExplored`)? Nothing is said about ground it has not. */
  readonly known: boolean;
  /** Can this player see it right now (`visibleTiles`)? Only this decides whether a unit is named. */
  readonly visible: boolean;
  /** The terrain's own name, when the tile is known. */
  readonly terrain?: string;
  /** The engine's own yields for the tile, improvements folded in (`tileYields`). */
  readonly yields?: TerrainYields;
  /** The names of the improvements standing on the tile, in the engine's own catalog order. */
  readonly improvements: readonly string[];
  /** What is standing there, named only as far as the fog allows. */
  readonly occupant?: string;
  /** Absent when no unit is selected, or when the tile is where that unit already stands. */
  readonly movement?: MovementReadout;
  /** Absent when nothing foreign is on the tile, so an empty tile never talks about combat. */
  readonly combat?: CombatReadout;
}

/** A unit as the readout names it: the ruleset's own name for the type, plus the engine's id. */
const unitName = (ruleset: RulesetView, type: UnitTypeId, id: UnitId): string =>
  `${unitDef(ruleset, type)?.name ?? type} ${String(id)}`;

/**
 * The movement answer for `unitId` on `tile` — `planMove` first, then the route query.
 *
 * The order matters and it is not merely a preference: `planMove` answers "what does *this step*
 * cost" and only exists for a neighbour, while `planRoute` answers "is there a way at all" and is
 * what a click on a far tile would use. A near tile that the engine refuses (an enemy standing
 * there, a mountain) is reported by `planMove`'s own error — the specific one, naming the reason —
 * and `planRoute` is only asked when `planMove` says "that is not a single step". When neither has
 * an answer, the route query's sentence is shown, because it is about the *journey* the player is
 * asking for and it is the engine's own text either way.
 */
const movementFor = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  tile: TileIndex,
): MovementReadout => {
  const step = planMove(state, ruleset, unitId, tile);
  if (step.ok) {
    return { kind: 'cost', cost: step.value.cost, movementLeft: step.value.movementLeft };
  }
  const route = planRoute(state, ruleset, unitId, tile);
  if (route.ok && route.value.steps.length > 0) {
    return { kind: 'route', steps: route.value.steps.length };
  }
  return { kind: 'refused', reason: problemText(route.ok ? step.error : route.error) };
};

/**
 * The combat answer for `unitId` against what stands on `tile`, or `undefined`.
 *
 * Two steps, in this order, and the first is what keeps this honest:
 *
 * 1. **The engine's offered list decides.** `unitActions` is where an attack the engine would accept
 *    appears, so the fold below only ever runs on a command that is genuinely on offer — the same
 *    rule the map's click handler follows. No odds are ever computed for an attack the player could
 *    not give.
 * 2. **The fold, on a copy.** `applyCommand` is the real applier; its `CombatResolved` event carries
 *    `attackerWinPct`, the engine's own number. `CityCaptured` instead of `CombatResolved` means
 *    there was nothing to fight.
 *
 * When no attack is offered, the readout shows the engine's *reason* rather than nothing — asked of
 * `planAttackUnit`, the applier's own evaluator — because "no odds shown" and "you cannot attack"
 * are different sentences to a player, and only one of them is true.
 */
const combatFor = (
  state: GameState,
  ruleset: RulesetView,
  viewer: PlayerId,
  unitId: UnitId,
  tile: TileIndex,
  offered: readonly Command[],
): CombatReadout => {
  const attack = offered.find(
    (command): command is Extract<Command, { type: 'AttackUnit' }> =>
      command.type === 'AttackUnit' && command.target === tile,
  );
  if (attack === undefined) {
    const plan = planAttackUnit(state, ruleset, viewer, unitId, tile);
    return plan.ok ? { kind: 'capture' } : { kind: 'refused', reason: problemText(plan.error) };
  }
  const folded = applyCommand(state, viewer, attack, ruleset);
  if (!folded.ok) return { kind: 'refused', reason: problemText(folded.error) };
  const events: readonly GameEvent[] = folded.value.events;
  const battle = events.find(
    (event): event is Extract<GameEvent, { type: 'CombatResolved' }> =>
      event.type === 'CombatResolved',
  );
  if (battle !== undefined) return { kind: 'odds', perRoundPct: battle.attackerWinPct };
  const captured = events.some((event) => event.type === 'CityCaptured');
  return captured
    ? { kind: 'capture' }
    : { kind: 'refused', reason: 'the engine resolved no battle' };
};

/**
 * Everything the readout knows about `tile`, as data rather than as a sentence.
 *
 * `selected` is the unit the player is looking at; without one the yields are still worth reading,
 * which is why only the movement and combat fields depend on it. Nothing here dispatches and nothing
 * writes to the state: the one mutation in the module is `applyCommand`'s, on a copy that is thrown
 * away in the same expression.
 */
export const hoverReadout = (
  state: GameState,
  ruleset: RulesetView,
  viewer: PlayerId,
  selected: UnitId | undefined,
  tile: TileIndex,
): TileReadout => {
  const x = indexToX(state.map, tile);
  const y = indexToY(state.map, tile);
  const known = isExplored(state, viewer, tile);
  const visible = visibleTiles(state, viewer).some((each) => each === tile);

  // Only for ground the player has seen: naming the terrain of an unexplored tile is the §7.8 leak
  // moved from the renderer into a tooltip, and `render.ts` deliberately paints such a tile flat.
  const terrainId = known ? state.map.terrain[tile] : undefined;
  const terrain = ruleset.terrains.find((def) => def.id === terrainId);
  // The engine's own read for the tile's worth, improvements included. Read only for a tile the
  // player has seen: an unexplored tile's yields are exactly the fog leak §7.8 removed from the
  // renderer, moved into a tooltip.
  const yields = known ? tileYields(state, ruleset, tile) : undefined;
  const improvements = known
    ? improvementsAt(state, tile).map((kind) => improvementDef(ruleset, kind)?.name ?? String(kind))
    : [];

  const unit = state.units.find((each) => each.tile === tile);
  const city = state.cities.find((each) => each.tile === tile);
  // Units are named only where the player can see them *now* (the marker rule); a city the player
  // has explored is named from memory, which is the same choice `cityMarkers` makes and states.
  const occupant =
    unit !== undefined && (unit.owner === viewer || visible)
      ? `${unitName(ruleset, unit.type, unit.id)}${unit.owner === viewer ? ' (yours)' : ' (rival)'}`
      : city !== undefined && known
        ? `${city.name}${city.owner === viewer ? ' (yours)' : ' (rival)'}`
        : undefined;

  const mover =
    selected === undefined ? undefined : state.units.find((each) => each.id === selected);
  const movement =
    mover === undefined || mover.tile === tile
      ? undefined
      : movementFor(state, ruleset, mover.id, tile);

  // A foreign unit or city is what makes this tile an attack target at all; an empty tile never
  // talks about combat, and asking `planAttackUnit` about one would answer `nothing-to-attack` on
  // every square of the map.
  const foreign = unit !== undefined && unit.owner !== viewer && visible ? unit : undefined;
  const enemyCity = city !== undefined && city.owner !== viewer && known ? city : undefined;
  const offers = mover === undefined ? [] : unitActions(state, ruleset, mover.id);
  const combat =
    mover === undefined || (foreign === undefined && enemyCity === undefined)
      ? undefined
      : combatFor(state, ruleset, viewer, mover.id, tile, offers);

  return {
    x,
    y,
    known,
    visible,
    ...(terrain === undefined ? {} : { terrain: terrain.name }),
    ...(yields === undefined ? {} : { yields }),
    improvements,
    ...(occupant === undefined ? {} : { occupant }),
    ...(movement === undefined ? {} : { movement }),
    ...(combat === undefined ? {} : { combat }),
  };
};

/** `2 food, 1 shield, 0 commerce` — the engine's three yield numbers, printed and nothing more. */
const yieldsText = (yields: TerrainYields): string =>
  `${String(yields.food)} food, ${String(yields.shields)} shield${
    yields.shields === 1 ? '' : 's'
  }, ${String(yields.commerce)} commerce`;

/** What the movement answer reads as. */
const movementText = (movement: MovementReadout): string => {
  if (movement.kind === 'cost') {
    return `moving there costs ${String(movement.cost)}, leaving ${String(
      movement.movementLeft,
    )} movement`;
  }
  if (movement.kind === 'route') {
    return `${String(movement.steps)} steps away by the engine’s own route`;
  }
  return `you cannot move there: ${movement.reason}`;
};

/** What the combat answer reads as. */
const combatText = (combat: CombatReadout): string => {
  if (combat.kind === 'odds') {
    return `attacking now, the engine gives ${String(
      combat.perRoundPct,
    )} percent per round of combat`;
  }
  if (combat.kind === 'capture') return 'attacking now takes the city, which nothing is defending';
  return `you cannot attack it: ${combat.reason}`;
};

/**
 * The readout as one sentence, which is what the element shows and what its `title` carries.
 *
 * Assembled from the data above with no arithmetic and no engine call: every figure in the sentence
 * was read out of the engine before this function ran, and a reader of the sentence is reading the
 * engine's answers in the order a player asks for them (what is it, what is on it, what would it
 * cost, what would a fight be).
 */
export const readoutText = (readout: TileReadout): string => {
  const where = `${String(readout.x)},${String(readout.y)}`;
  if (!readout.known) return `${where} — unexplored ground`;
  const parts: string[] = [];
  const terrain = readout.terrain ?? 'unknown terrain';
  parts.push(readout.yields === undefined ? terrain : `${terrain}, ${yieldsText(readout.yields)}`);
  if (readout.improvements.length > 0) parts.push(`with ${readout.improvements.join(', ')}`);
  if (readout.occupant !== undefined) parts.push(readout.occupant);
  if (readout.movement !== undefined) parts.push(movementText(readout.movement));
  if (readout.combat !== undefined) parts.push(combatText(readout.combat));
  return `${where} — ${parts.join('; ')}`;
};
