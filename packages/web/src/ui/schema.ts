/**
 * THE UI SCHEMA — every command, and the one surface that presents it.
 *
 * ------------------------------------------------------------------ *
 * Why this file exists
 * ------------------------------------------------------------------ *
 *
 * `docs/UI-OVERHAUL.md` §2 makes the case that a map-centric interface is not a visual decision but
 * a *classification* decision: for each command the engine can accept, there is exactly one right
 * place to present it, and once that is written down the layout follows from it rather than being
 * argued about. This module is that table.
 *
 * The numbers it produces are the answer to "should the UI recede, and how far?". There are twelve
 * commands. **One** of them belongs in permanent chrome. That is not an aesthetic preference; it is
 * a count, and it can be re-derived from this file at any time.
 *
 * ------------------------------------------------------------------ *
 * Surface — where a command is presented
 * ------------------------------------------------------------------ *
 *
 * - `map`       the control IS a map tile. Nothing is rendered; the affordance is a highlight and
 *               the act is a click on the ground the command names.
 * - `cluster`   a small transient control anchored to the current selection. Exists only while
 *               something is selected, and is dismissed with it.
 * - `workspace` a panel the player *enters* and *leaves*. These need reading time and real estate.
 * - `ambient`   always on screen and as small as legibility allows.
 *
 * ------------------------------------------------------------------ *
 * Enumeration — and why it is per context, not per command
 * ------------------------------------------------------------------ *
 *
 * The keystone invariant (`docs/INTERFACES.md:1848-1850`) says every action the engine accepts for a
 * unit or city must be reachable from the UI. What it *obliges* the UI to offer is therefore not a
 * property of a command on its own but of **a command in a context**: the engine hands the UI a list
 * for a selected unit, a different list for a selected city, and a third for the player as a whole.
 *
 * An earlier version of this file carried a single global `provenance` field of `enumerated` or
 * `queried`, and that was **wrong** — not merely coarse. It labelled `SetProduction` as queried,
 * while `e2e/keystone.spec.ts:83` has always treated it as enumerated for a city, and that spec's
 * own doc comment lists `SetProduction` among the queried ones. Both readings existed in the repo
 * and neither could be checked, because "is it enumerated?" has no answer without asking "for what?".
 *
 * The answer, confirmed against the engine rather than by argument:
 *
 * - `unitActions` (`actions.ts:246`) yields a list **for a unit**;
 * - `cityProductionOptions` (`actions.ts:323`) yields a list **for a city** — items, which the seam
 *   wraps into one `SetProduction` each (`testapi.ts:340-342`), so for a city it *is* enumerated;
 * - `legalActions` (`actions.ts:395`) yields a list **for the player**. It is the union of every one of
 *   the player's units' lists, with one `EndTurn` appended last — so a unit command is enumerated in
 *   *both* contexts, and only `EndTurn` belongs to the player context alone. That was measured by
 *   asking the engine (`schema.test.ts`), not assumed: the first draft of this table claimed the
 *   player context held `EndTurn` and nothing else, and the engine refused it.
 *
 * `FortifyUnit`, `SetRates`, `SetResearch`, `SetGovernment` and `SetWorkedTiles` are in **no** list,
 * and `actions.ts:47-55` and `:82-93` give the reason: their spaces are search spaces or choice
 * boards, and a generator that yielded them "would be advertising a choice board as if it were the
 * player's whole move set". Those are the ones reached by asking a `plan*` evaluator, and the UI may
 * present one only where that evaluator accepts it.
 */

import type { Command, TileIndex, UnitId } from '@civts/core';
import { assertNever } from '../events.js';

/** Where a command is presented. See the module note for what each one means. */
export type Surface = 'map' | 'cluster' | 'workspace' | 'ambient';

/**
 * Whose selection the engine answers a question about.
 *
 * The three the engine actually has functions for — see the module note. There is deliberately no
 * `tile` context: a tile is something the player *inspects*, and inspecting issues nothing.
 */
export type Context = 'unit' | 'city' | 'player';

/** One row of the schema. */
export interface Placement {
  readonly surface: Surface;
  /**
   * The contexts in which the engine hands the UI a **list** of these commands — the contexts in
   * which the UI is obliged to offer one. Empty means no generator yields it in any context, so it is
   * reached only by asking a `plan*` evaluator.
   *
   * A list rather than a boolean because the honest answer is per context: `SetProduction` is
   * enumerated for a city and for nothing else.
   */
  readonly enumeratedIn: readonly Context[];
  /**
   * For a `map` command, the payload field that names the tile. Absent for every other surface, and
   * its absence is meaningful: "this command has no ground to point at".
   *
   * Never written as an explicit `undefined` — the same rule the game state follows, and for the
   * same reason (a key whose value is `undefined` does not survive a round trip).
   */
  readonly tileField?: 'to' | 'target';
}

/**
 * THE TABLE. Total over `Command['type']` by construction.
 *
 * Read the surfaces as a sentence about the game: *two* commands are about ground, *four* are about
 * the unit you have selected, *five* are choice boards, and *one* is the turn.
 */
export const COMMAND_PLACEMENT = {
  // The two commands that name a map tile. These are the whole of "map-centric": the map is not a
  // place where the game is displayed and then narrated by buttons, it is where these two are
  // issued. `main.ts` resolves a tile click against exactly this pair, through `tileNamedBy` below.
  MoveUnit: { surface: 'map', enumeratedIn: ['unit', 'player'], tileField: 'to' },
  AttackUnit: { surface: 'map', enumeratedIn: ['unit', 'player'], tileField: 'target' },

  // The unit's own orders: they act on the piece you have selected and need no ground named.
  // `FortifyUnit` sits with them although no generator yields it anywhere — which is why the
  // enumeration column exists, and why "is it offered?" and "where is it presented?" are separate
  // questions with separate answers.
  FoundCity: { surface: 'cluster', enumeratedIn: ['unit', 'player'] },
  StartWork: { surface: 'cluster', enumeratedIn: ['unit', 'player'] },
  CancelWork: { surface: 'cluster', enumeratedIn: ['unit', 'player'] },
  FortifyUnit: { surface: 'cluster', enumeratedIn: [] },

  // Choice boards. Four of these are in no list at all; `SetProduction` is the exception, and the
  // reason this column is a list — the city's own query hands the UI every item it may build, so for
  // a city the UI is obliged to offer them all.
  SetProduction: { surface: 'workspace', enumeratedIn: ['city'] },
  SetWorkedTiles: { surface: 'workspace', enumeratedIn: [] },
  SetResearch: { surface: 'workspace', enumeratedIn: [] },
  SetRates: { surface: 'workspace', enumeratedIn: [] },
  SetGovernment: { surface: 'workspace', enumeratedIn: [] },

  // One command in twelve belongs in permanent chrome. Everything else has an occasion.
  //
  // Enumerated for the PLAYER, not for a unit: `actions.ts:127-137` is explicit that a unit's actions
  // are its own, so `unitActions` deliberately does not yield the turn. Only `legalActions` appends
  // it, once, last.
  EndTurn: { surface: 'ambient', enumeratedIn: ['player'] },
} as const satisfies Record<Command['type'], Placement>;

/** The surface a command type is presented on. */
export const surfaceOf = (type: Command['type']): Surface => COMMAND_PLACEMENT[type].surface;

/** The contexts in which the engine hands the UI a list containing this command. */
export const enumerationContextsOf = (type: Command['type']): readonly Context[] =>
  COMMAND_PLACEMENT[type].enumeratedIn;

/** Whether the engine enumerates this command in this context — i.e. whether the UI owes it one. */
export const isEnumerated = (type: Command['type'], context: Context): boolean =>
  COMMAND_PLACEMENT[type].enumeratedIn.some((each) => each === context);

/**
 * Every command the engine enumerates in a given context.
 *
 * This is the list the keystone sweep's *reachability* direction is about: everything here must be
 * producible by clicking something, and `e2e/keystone.spec.ts` should derive its expectation from
 * this function rather than from a hand-maintained set that can drift from the UI it checks.
 */
export const enumeratedIn = (context: Context): readonly Command['type'][] =>
  (Object.keys(COMMAND_PLACEMENT) as Command['type'][]).filter((type) =>
    isEnumerated(type, context),
  );

/**
 * The tile a map order names, or `undefined` for a command that is not a map order.
 *
 * **The single definition of "which tile does this command point at".** `main.ts` used to carry its
 * own copy as an `if` chain; a click handler that derives the tile differently from the schema is
 * the same class of defect as a second inverse projection, which `docs/INTERFACES.md:1908` bans
 * outright.
 *
 * The switch has **no `default`**, so a new command member is a compile error here as well as in the
 * table. The duplication between the two is deliberate and `schema.test.ts` proves they agree — a
 * table that says `map` while this function returns `undefined` would mean a command the schema
 * claims the map can issue and the map silently cannot.
 */
export const tileNamedBy = (command: Command): TileIndex | undefined => {
  switch (command.type) {
    case 'MoveUnit':
      return command.to;
    case 'AttackUnit':
      return command.target;
    case 'EndTurn':
    case 'FoundCity':
    case 'StartWork':
    case 'CancelWork':
    case 'FortifyUnit':
    case 'SetProduction':
    case 'SetWorkedTiles':
    case 'SetResearch':
    case 'SetRates':
    case 'SetGovernment':
      return undefined;
  }
  return assertNever(command);
};

/** Whether this command is one the map itself can issue, by clicking the tile it names. */
export const isMapCommand = (command: Command): boolean =>
  COMMAND_PLACEMENT[command.type].surface === 'map';

/**
 * The unit a command acts on, or `undefined` for a command that names no unit.
 *
 * **Why the schema owns this.** A goto is UI intent held against a unit id, and an order given to
 * *that* unit replaces the goto (the player has said what the unit should do instead). Asking that
 * question needs "which unit does this command name", and the answer has to be stated once: an `if`
 * chain in the click handler and another in the order channel is the same duplicated-rule defect
 * `tileNamedBy` above exists to prevent. Like that function, the switch has **no `default`**, so a
 * new command member stops the build until somebody says whether it names a unit — the question a
 * silent `undefined` would answer wrong for a command that does.
 */
export const unitNamedBy = (command: Command): UnitId | undefined => {
  switch (command.type) {
    case 'MoveUnit':
    case 'AttackUnit':
    case 'FoundCity':
    case 'StartWork':
    case 'CancelWork':
    case 'FortifyUnit':
      return command.unitId;
    case 'EndTurn':
    case 'SetProduction':
    case 'SetWorkedTiles':
    case 'SetResearch':
    case 'SetRates':
    case 'SetGovernment':
      return undefined;
  }
  return assertNever(command);
};

/**
 * How many commands each surface carries.
 *
 * Exported because the count is the schema's headline claim — *one* command in permanent chrome —
 * and a claim that is re-derived from the table is one that cannot rot when the table changes.
 */
export const surfaceCounts = (): Readonly<Record<Surface, number>> => {
  const counts: Record<Surface, number> = { map: 0, cluster: 0, workspace: 0, ambient: 0 };
  for (const placement of Object.values(COMMAND_PLACEMENT)) {
    counts[placement.surface] += 1;
  }
  return counts;
};
