/**
 * The unit panel: the player's units, the selected unit, and **the engine's own list of
 * what that unit may do**.
 * See docs/INTERFACES.md, M8 ("The accessibility contract": `region`/`Units` and
 * `group`/`Actions for unit <id>`), and the M8 rule the whole package is built on — "The
 * UI must not contain game rules".
 *
 * ## The action group is `unitActions`, verbatim, and nothing else
 *
 * `unitActions(state, ruleset, unitId)` is the engine's answer to "what may this unit do
 * now?", and it is built out of the *appliers'* own evaluators (`planFoundCity`,
 * `planStartWork`, `planCancelWork`, `planMove`, `planAttackUnit`), so a button rendered
 * from it cannot be an action the engine would refuse. This panel does exactly that and
 * adds nothing: one `<button>` per command, in the engine's order, labelled by a pure
 * function of the command (`actionLabel`). It never filters, sorts, greys out or extends
 * the list — a filter here would be a second, UI-side statement of legality, which is the
 * one thing this layer is forbidden to own.
 *
 * ## Fortify: the group carries the engine's queried commands too
 *
 * `unitActions` deliberately does **not** return `FortifyUnit`. Fortify is on the engine's
 * *queried* side — `planFortifyUnit` accepts it and `applyCommand` applies it, but no
 * generator advertises it, because it emits no event and an advertised action with no
 * observable effect is treated (correctly) as a drifted generator — and A4 still names
 * fortify among the unit orders the UI must offer. Attacks are not in that position: M6
 * extends the *enumerated* half, so `unitActions` already yields one `AttackUnit` per
 * adjacent tile `planAttackUnit` accepts.
 *
 * So the group is the union of the two engine answers, in that order:
 *
 * 1. every command `unitActions(state, ruleset, unitId)` returns, in the engine's order;
 * 2. `FortifyUnit`, when this unit's own `planFortifyUnit` accepts it.
 *
 * Both halves are engine decisions and neither is a rule written here: the panel filters
 * nothing, invents no target and computes no cost. A test can still compare the group's
 * *enumerated* commands with `actionsFor(unitId)` one for one, and fortify — the one queried
 * command the group adds — is a command the applier accepts, which is the property that
 * matters: **no control is offered that the engine would refuse.**
 *
 * ## Everything shown is an engine readout
 *
 * The hit-point string and the job string come from `textview.ts`' `hitPointsLabel` and
 * `workSummary`, the movement figure is the unit's own `movementLeft`, and the fortified
 * flag is `units.ts`' `isFortified`. Formatting is this file's job; the *numbers* are the
 * engine's, and a second way to compute any of them would be a second answer.
 */

import {
  experienceOf,
  hitPointsLabel,
  improvementDef,
  indexToX,
  indexToY,
  isFortified,
  planFortifyUnit,
  techDef,
  unitActions,
  unitById,
  unitDef,
  workSummary,
  type Command,
  type GameState,
  type PlayerId,
  type RulesetView,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { assertNever, governmentLabel, productionItemName } from '../events.js';
import { commandsClosed } from './closed.js';
import type { PanelContext } from './index.js';

/** One row of the unit list: the engine's readouts for a unit, already formatted. */
export interface UnitRow {
  readonly id: UnitId;
  /** `<type name> <id>` — the same spelling the event log uses. */
  readonly label: string;
  readonly tileText: string;
  readonly movementLeft: number;
  /** `2/3 hp`, from `textview.ts`' `hitPointsLabel`. */
  readonly hitPoints: string;
  /** `mining, 2 turns left`, or absent when the unit is idle. */
  readonly work?: string;
  readonly fortified: boolean;
  /** Experience level; 0 when the unit has never won a battle. */
  readonly experience: number;
}

const tileLabel = (state: GameState, tile: TileIndex): string =>
  `${String(indexToX(state.map, tile))},${String(indexToY(state.map, tile))}`;

/**
 * The player's units, in `state.units` order (sorted by id, so the list is stable across
 * frames and across saves). Barbarians' and other players' units are not this panel's
 * business: the region is the *player's* units, and a list that mixed owners would make
 * "select this unit" ambiguous.
 */
export const unitRows = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly UnitRow[] => {
  const rows: UnitRow[] = [];
  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    const def = unitDef(ruleset, unit.type);
    rows.push({
      id: unit.id,
      label: `${def?.name ?? unit.type} ${String(unit.id)}`,
      tileText: tileLabel(state, unit.tile),
      movementLeft: unit.movementLeft,
      hitPoints: hitPointsLabel(unit, def),
      fortified: isFortified(unit),
      experience: experienceOf(unit),
      // The key is **omitted** when the unit is idle, never written as `undefined` — the
      // same rule the state follows (`exactOptionalPropertyTypes` plus a JSON round trip).
      ...(unit.work === undefined ? {} : { work: workSummary(ruleset, unit.work) }),
    });
  }
  return rows;
};

/**
 * The engine's answer to "what may this unit do?", unmodified — see the module note.
 * Exported so the panel, a test and the app's own test seam can all name the same list.
 */
export const unitActionList = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): readonly Command[] => unitActions(state, ruleset, unitId);

/**
 * The engine's **queried** commands for this unit: `FortifyUnit` when `planFortifyUnit`
 * accepts it, and nothing otherwise.
 *
 * Attacks are deliberately absent because they are not queried — `unitActions` enumerates
 * them (`planAttackUnit` is the applier's own evaluator and the generator calls it per
 * neighbour), so adding them here would offer the same command twice.
 */
export const unitQueriedActions = (
  state: GameState,
  playerId: PlayerId,
  unitId: UnitId,
): readonly Command[] =>
  planFortifyUnit(state, playerId, unitId).ok ? [{ type: 'FortifyUnit', unitId }] : [];

/**
 * **What the group renders**: the engine's enumerated list followed by its queried commands.
 *
 * This is the single statement of the group's contents, used by the panel and by the tests —
 * so "what the UI offers for this unit" has one definition rather than one in the DOM and a
 * second in a test.
 */
export const unitPanelCommands = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
): readonly Command[] => [
  ...unitActionList(state, ruleset, unitId),
  ...unitQueriedActions(state, playerId, unitId),
];

/**
 * What a button that issues `command` says. Pure and total over the `Command` union: the
 * switch has **no `default`**, so a new command member is a compile error here rather than
 * an unlabelled button, and the tail passes the narrowed value to `assertNever`.
 *
 * Labels are unique **within one unit's list**, which is what matters for a test that
 * clicks "the button named X": two moves differ by their coordinates, two jobs by their
 * improvement's name, and two attacks by their target's coordinates.
 */
export const actionLabel = (command: Command, state: GameState, ruleset: RulesetView): string => {
  switch (command.type) {
    case 'MoveUnit':
      return `Move to ${tileLabel(state, command.to)}`;
    case 'EndTurn':
      return 'End turn';
    case 'FoundCity':
      return 'Found city';
    case 'SetWorkedTiles':
      return `Set worked tiles for city ${String(command.cityId)}`;
    case 'SetProduction':
      return `Build ${productionItemName(ruleset, command.item)}`;
    case 'StartWork':
      return `Start work: ${improvementDef(ruleset, command.kind)?.name ?? command.kind}`;
    case 'CancelWork':
      return 'Cancel work';
    case 'SetRates':
      return `Set rates ${String(command.rates.tax)}/${String(command.rates.science)}/${String(command.rates.luxury)}`;
    case 'SetResearch':
      return `Research ${techDef(ruleset, command.tech)?.name ?? command.tech}`;
    case 'AttackUnit':
      return `Attack ${tileLabel(state, command.target)}`;
    case 'FortifyUnit':
      return 'Fortify';
    // M9: the government command is not a unit command and never reaches this panel's
    // action list — but the switch is exhaustive over `Command`, so the member is handled
    // explicitly rather than falling through to `assertNever` as an unreachable branch.
    case 'SetGovernment':
      return `Change government to ${governmentLabel(ruleset, command.government)}`;
  }
  return assertNever(command);
};

/**
 * The unit the panel shows as selected: the caller's choice when it is this player's unit,
 * otherwise **the first unit this player owns**, in id order.
 *
 * Falling back rather than showing nothing is a deliberate choice: a fresh game has units
 * and no selection, and a panel whose action group is empty until something else selects a
 * unit would make "what can I do?" unanswerable at the moment the player first asks it. The
 * fallback is deterministic (lowest id), so two frames on the same state agree.
 */
export const defaultUnitId = (
  state: GameState,
  playerId: PlayerId,
  selected: UnitId | undefined,
): UnitId | undefined => {
  const unit = selected === undefined ? undefined : unitById(state, selected);
  if (unit !== undefined && unit.owner === playerId) return unit.id;
  return state.units.find((candidate) => candidate.owner === playerId)?.id;
};

/** The selected unit's row, or `undefined` when nothing is selected. */
export const selectedUnitRow = (
  rows: readonly UnitRow[],
  unitId: UnitId | undefined,
): UnitRow | undefined => rows.find((row) => row.id === unitId);

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A `<button>` that runs `command` through the engine (which re-renders every panel). */
const actionButton = (ctx: PanelContext, label: string, command: Command): HTMLButtonElement => {
  const button = el(ctx.api.document, 'button', label);
  button.type = 'button';
  button.dataset['command'] = command.type;
  button.addEventListener('click', () => {
    ctx.dispatch(command);
  });
  return button;
};

export interface UnitPanelHandle {
  /** The `region` named `Units` — the unit list and the selected unit's readouts. */
  readonly element: HTMLElement;
  /**
   * The `group` named `Actions for unit <id>`, a **sibling** of the region rather than a child
   * of it — see the mount note.
   */
  readonly actions: HTMLElement;
  refresh(): void;
}

/**
 * Mount the unit region and the action group into `parent`: `role="region"` named `Units`
 * holding the unit list and the selected unit's readouts, and — beside it, **not inside it** —
 * `role="group"` named `Actions for unit <id>`, whose buttons are `unitPanelCommands`: the
 * engine's enumerated list plus its queried fortify.
 *
 * **Why the group is a sibling.** The region's contract is "the player's units", and the only
 * controls that belong to it are the unit rows. Nesting the action buttons inside it would make
 * a query like "how many buttons does the Units region have?" count orders rather than units,
 * which is a real difference a reader (and a test) is entitled to rely on. The group is still
 * adjacent in the DOM and on screen — the panel and its orders read together — but the two
 * landmark roles stay unambiguous.
 */
export const mountUnitPanel = (parent: HTMLElement, ctx: PanelContext): UnitPanelHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'section');
  element.setAttribute('aria-label', 'Units');
  element.dataset['panel'] = 'units';
  const list = el(doc, 'ul');
  const detail = el(doc, 'div');
  const actions = el(doc, 'div');
  actions.setAttribute('role', 'group');
  element.append(el(doc, 'h2', 'Units'), list, detail);
  parent.append(element, actions);

  const refresh = (): void => {
    const state = ctx.api.state();
    const ruleset = ctx.api.ruleset;
    const playerId = ctx.api.playerId();
    const rows = unitRows(state, ruleset, playerId);
    const selected = defaultUnitId(state, playerId, ctx.selection().unitId);

    list.replaceChildren();
    for (const row of rows) {
      const item = el(doc, 'li');
      const button = el(doc, 'button', row.label);
      button.type = 'button';
      if (row.id === selected) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => {
        ctx.selectUnit(row.id);
      });
      item.append(button);
      list.append(item);
    }

    detail.replaceChildren();
    actions.replaceChildren();

    const row = selectedUnitRow(rows, selected);
    if (row === undefined) {
      detail.append(el(doc, 'p', 'No unit selected.'));
      actions.setAttribute('aria-label', 'Actions for unit none');
      return;
    }

    detail.append(
      el(
        doc,
        'p',
        `${row.label} at ${row.tileText} — ${row.hitPoints}, ${String(row.movementLeft)} movement left` +
          (row.fortified ? ', fortified' : '') +
          (row.experience > 0 ? `, level ${String(row.experience)}` : '') +
          (row.work === undefined ? '' : `, ${row.work}`),
      ),
    );

    actions.setAttribute('aria-label', `Actions for unit ${String(row.id)}`);
    // M10: a finished game refuses every command (`game-over`), so the group's controls are
    // rendered disabled rather than removed — the orders are still what this unit *could* do, and
    // the one honest thing to say about them is that the engine will not take them any more. A
    // disabled control is not one the page offers (docs/INTERFACES.md, M8 keystone).
    const closed = commandsClosed(ctx.api);
    for (const command of unitPanelCommands(state, ruleset, playerId, row.id)) {
      const control = actionButton(ctx, actionLabel(command, state, ruleset), command);
      control.disabled = closed;
      actions.append(control);
    }
  };

  // Deliberately **not** refreshed here: `mountPanels` renders every panel once it has
  // mounted them all, because `refresh` touches its siblings and they are not built yet.
  return { element, actions, refresh };
};
