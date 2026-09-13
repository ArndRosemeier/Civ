/**
 * W4 — **adversarial verification of M8**: the UI adds no rules.
 *
 * `docs/INTERFACES.md` M8 states the property this file exists to attack:
 *
 * > Every action goes through `legalActions` / `applyCommand`. The UI may not compute legality,
 * > costs or outcomes, and may not offer a control whose action the engine would refuse. […]
 * > **every control the UI offers must be accepted by the engine, and every action the engine
 * > accepts for a unit or city must be reachable** from the UI for that unit or city.
 *
 * `keystone.spec.ts` (W3) proves that property for the controls it knows about. This file is the
 * adversary: it assumes the property is false and goes looking for the counterexample in the places
 * a friendly test does not look — every button on the page rather than the ones a person would
 * press, other unit types and later positions, the queried setters (rates, research, worked tiles,
 * production), a source scan for rules arithmetic, a hash-mismatched save, two browser contexts
 * instead of one, and the panels and the draw trace after a dispatch.
 *
 * **A finding is the deliverable, and an empty report is a valid one.** Nothing here is written to
 * pass: each test states a property, computes its evidence from the engine's own lists, and fails
 * with the counterexample when it has one. Where the M8 scope deliberately leaves a gap, the test
 * *records* the gap as a pinned fact — so a new one cannot appear silently — rather than pretending
 * the gap is a failure of the keystone property. See the `SetRates` note in the queried-setters
 * test.
 *
 * Two of the checks the milestone asks for cannot live in a spec file, because both need the app
 * edited and the suite re-run: the **broken renderer** (do the pixel tests actually go red?) and
 * the **illegal control** (does a control the engine refuses actually fail the suite?). They are run
 * as recorded mutation checks whose evidence — the file hash before and after, and the red run — is
 * in the milestone report. The pixel tests' own predicate is additionally falsified in-process here
 * (`pixel sampling is not vacuous`), so the mutation is not the only thing standing between a
 * broken renderer and a green suite.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CATALOG } from '@civts/rules';
import { applyCommand, planSetRates } from '@civts/core';

import { eventLines } from '../src/events.js';
import {
  actionTarget,
  actionType,
  actionUnitId,
  actionsFor,
  bringTileToCentre,
  cameraOf,
  canonicalAction,
  canvasBox,
  cityDialog,
  clearDispatchLog,
  clickTileOrder,
  closeDialogs,
  colourDistance,
  describeColour,
  dispatch,
  dispatchLog,
  drawTraceOf,
  endTurnButton,
  endTurns,
  eventLog,
  expectReady,
  foundCity,
  hashOf,
  headlessNewGame,
  humanPlayer,
  humanPlayerId,
  isExplored,
  luxuryIndicator,
  openApp,
  openCity,
  openPanel,
  paletteOf,
  parseHexColour,
  readSettings,
  readState,
  recordDispatches,
  replayScript,
  sampleTileColour,
  saveButton,
  scienceIndicator,
  scoreboard,
  seedApp,
  selectUnit,
  settingsFrom,
  stateHash,
  stateHashIndicator,
  terrainAtTile,
  tileCentre,
  tileIsClear,
  tileX,
  tileY,
  treasuryIndicator,
  turnIndicator,
  unitAbilitiesGroup,
  unitActionButtons,
  unitById,
  unitPanel,
  unitsOf,
  visibleTiles,
  yearIndicator,
  RULESET,
  type UiState,
} from './helpers.js';

/* ------------------------------------------------------------------ *
 * What this file needs: the seeds, the shapes, and the small pieces of
 * arithmetic over the TEST's own data (never over a rule)
 * ------------------------------------------------------------------ */

/** The golden seeds, so a finding is reproducible against a golden state hash. */
const SEEDS = [1, 42, 1337] as const;

/** The seed the mid-game, save/load and screenshot tests play. */
const MID_GAME_SEED = 4242;

/**
 * The command types whose membership in an engine list this file can check.
 *
 * `legalActions` yields every unit's `unitActions` plus `EndTurn`; the frozen seam's
 * `actionsFor(unitId)` and `actionsFor(cityId)` publish those same generators, the city's menu as
 * the `SetProduction` commands that carry each item. The remaining commands are **queried setters**
 * — `SetRates`, `SetResearch`, `SetWorkedTiles`, `FortifyUnit` — which the engine deliberately does
 * not enumerate (core `actions.ts`: a search space over content is not an action list). Those are
 * judged by the engine's own verdict — `applyCommand` accepting or refusing the click — and by the
 * queried-setters test.
 */
const LISTED_COMMANDS = new Set([
  'MoveUnit',
  'EndTurn',
  'FoundCity',
  'StartWork',
  'CancelWork',
  'AttackUnit',
  'SetProduction',
]);

/**
 * The queried setters whose route from the UI the queried-setters test checks, by name.
 *
 * Each one is a command the engine accepts and no generator enumerates, so a missing control for
 * one is a keystone gap ("every action the engine accepts for a unit or city must be reachable
 * from the UI") that only a sweep like that one can see. All four are exercised there: the city
 * screen's worked-tile checkboxes (`SetWorkedTiles`), the tech tree's rows (`SetResearch`), the
 * status strip's rates control (`SetRates`) and — M9 — the government selector beside it
 * (`SetGovernment`, whose rows are the catalog and whose judge is `planSetGovernment`).
 * `FortifyUnit` is deliberately *not* here — its control is a unit order, and the offered-direction
 * sweep in this same file clicks it through `Abilities for unit <id>`.
 */
const QUERIED_SETTERS = ['SetRates', 'SetResearch', 'SetWorkedTiles', 'SetGovernment'] as const;

/** A cap, so a sweep over a page that grows as it is clicked still terminates. */
const MAX_SWEEP_CLICKS = 120;

/** The app's own source, scanned by the "no rules in the UI" test. */
const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** Where the advisory screenshots go (advisory evidence only — see the screenshot test). */
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/m8-adversarial', import.meta.url));

/** One click's evidence, so the report can name what the UI actually dispatched. */
interface ClickRecord {
  readonly where: string;
  readonly label: string;
  readonly action: unknown;
}

type DispatchRecords = ClickRecord[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause);

/**
 * Every command the engine currently lists for the human seat: the player-level list, each unit's
 * own list, and each of the seat's cities' menus.
 *
 * Read through the frozen seam, which is the engine's own generator reached the way the app reaches
 * it — so "the engine's list" here is the list the panels were built from, not a second statement
 * of it assembled in this file.
 */
const engineLists = async (page: Page): Promise<readonly unknown[]> => {
  const state = await readState(page);
  const owner = humanPlayerId(state);
  const actions: unknown[] = [...(await actionsFor(page, {}))];
  for (const unit of unitsOf(state, owner)) {
    actions.push(...(await actionsFor(page, { unitId: unit.id })));
  }
  for (const city of state.cities) {
    if (city.owner !== owner) continue;
    actions.push(...(await actionsFor(page, { cityId: city.id })));
  }
  return actions;
};

const listedNow = async (page: Page): Promise<ReadonlySet<string>> =>
  new Set((await engineLists(page)).map(canonicalAction));

/**
 * Judge one dispatched command.
 *
 * A command the engine **refuses** is a finding, always: that is the keystone property, and the
 * refusal is the engine's own verdict rather than this file's opinion.
 *
 * A command of a **listed** type that is not in the engine's lists is a finding too, but the lists
 * are re-read before it is recorded: a list captured a few clicks ago describes an older position,
 * and a stale list must not be able to turn a legal command into a reported one. (A command that is
 * genuinely no longer listed is refused by the engine as well, so it is caught by the refusal
 * branch — the membership branch is the belt to that braces.)
 */
const judge = async (
  page: Page,
  where: string,
  label: string,
  action: unknown,
  result: string,
  findings: string[],
  records: DispatchRecords,
  listed: ReadonlySet<string>,
): Promise<void> => {
  records.push({ where, label, action });
  if (result !== 'ok') {
    findings.push(
      `${where} "${label}" dispatched ${JSON.stringify(action)} and the engine refused it`,
    );
    return;
  }
  if (!LISTED_COMMANDS.has(actionType(action))) return;
  if (listed.has(canonicalAction(action))) return;
  if ((await listedNow(page)).has(canonicalAction(action))) return;
  findings.push(
    `${where} "${label}" dispatched ${JSON.stringify(action)}, which is not in the engine's own ` +
      `list for the seat, its units or its cities`,
  );
};

/** Click one control and judge everything it dispatched. */
const clickAndJudge = async (
  page: Page,
  control: Locator,
  where: string,
  findings: string[],
  records: DispatchRecords,
  listed: ReadonlySet<string>,
): Promise<boolean> => {
  const label = (await control.innerText()).trim();
  await clearDispatchLog(page);
  try {
    await control.click({ timeout: 10_000 });
  } catch (cause) {
    findings.push(`${where} "${label}" could not be clicked: ${messageOf(cause)}`);
    return false;
  }
  const log = await dispatchLog(page);
  for (const entry of log) {
    await judge(page, where, label, entry.action, entry.result, findings, records, listed);
  }
  return log.length > 0;
};

/** Play a fresh seed to a mid-game position: a city on screen, its menu, and a produced unit. */
const playToMidGame = async (page: Page, seed: number): Promise<UiState> => {
  await openApp(page);
  await seedApp(page, seed);
  const city = await foundCity(page);
  await openCity(page, await readState(page), await cameraOf(page), city);
  const warrior = cityDialog(page, city.name).getByRole('button', { name: /^Build Warrior / });
  expect(await warrior.count(), 'the city menu has no Warrior to start building').toBeGreaterThan(
    0,
  );
  await warrior.first().click();
  await closeDialogs(page);
  // Long enough for the produced unit to appear: the tuned catalog prices it at a handful of
  // shields, and a city that has just been founded already works its own tile.
  await endTurns(page, 6);
  // The recorder goes on LAST, after the setup clicks: `recordDispatches` wraps the seam's
  // `dispatch` as it stands, so wrapping before the setup would either miss it (a navigation
  // replaces the seam) or wrap the wrapper (a double-wrapped dispatch is recorded twice).
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  return readState(page);
};

/** One control a unit is offering: which group, which position, and what it says. */
interface ControlSpec {
  readonly unitId: number;
  readonly group: 'actions' | 'abilities';
  readonly index: number;
  readonly label: string;
}

const groupButtons = (page: Page, unitId: number, group: 'actions' | 'abilities'): Locator =>
  group === 'actions'
    ? unitActionButtons(page, unitId)
    : unitAbilitiesGroup(page, unitId).getByRole('button');

/**
 * Select a unit and read the controls it is offering.
 *
 * The **selection comes first**, and that is the whole point of this helper: a unit's action group
 * only exists once the unit is selected, so reading the group before selecting it returns an empty
 * list — and an empty list of controls makes a sweep that clicks nothing pass for a sweep that found
 * nothing. (That is not a hypothesis: the first version of this file read the labels first, and the
 * unit half of the offered sweep was silently empty.)
 *
 * Controls are addressed by **index** from here on, not by accessible name: an index is stable
 * across identical replays of the same seed, while a name can be rewritten by the panel without
 * anything about reachability changing. The label is read for the finding's message.
 */
const controlsOf = async (page: Page, unitId: number): Promise<readonly ControlSpec[]> => {
  await selectUnit(page, await readState(page), await cameraOf(page), unitId);
  const specs: ControlSpec[] = [];
  for (const group of ['actions', 'abilities'] as const) {
    const buttons = groupButtons(page, unitId, group);
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      specs.push({ unitId, group, index, label: (await buttons.nth(index).innerText()).trim() });
    }
  }
  return specs;
};

/* ------------------------------------------------------------------ *
 * 1. KEYSTONE, THE OFFERED DIRECTION
 * ------------------------------------------------------------------ */

test('adversarial keystone — offered: no control on the page dispatches a command the engine refuses', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const findings: string[] = [];
  const records: DispatchRecords = [];

  for (const seed of SEEDS) {
    await openApp(page);
    await seedApp(page, seed);
    expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

    // A city first, so the sweep has a city screen, a production menu and a second unit type.
    const city = await foundCity(page);
    await openCity(page, await readState(page), await cameraOf(page), city);
    const buildCount = await cityDialog(page, city.name)
      .getByRole('button', { name: /^Build / })
      .count();
    expect(buildCount, 'the city screen offers nothing to build').toBeGreaterThan(0);
    for (let index = 0; index < buildCount; index += 1) {
      await openCity(page, await readState(page), await cameraOf(page), city);
      const control = cityDialog(page, city.name)
        .getByRole('button', { name: /^Build / })
        .nth(index);
      if ((await control.count()) === 0) continue;
      await clickAndJudge(
        page,
        control,
        `seed ${String(seed)} city build ${String(index)}`,
        findings,
        records,
        await listedNow(page),
      );
    }
    await closeDialogs(page);

    // A few turns, so produced units exist and the position is not the opening one.
    await endTurns(page, 5);

    // Each unit the seat owns, by every control it offers while it is selected — the action group
    // and the shell's abilities group (fortify, and one attack per neighbour the engine accepts).
    const state = await readState(page);
    const owner = humanPlayerId(state);
    const swept: string[] = [];
    for (const unit of unitsOf(state, owner)) {
      const specs = await controlsOf(page, unit.id);
      for (const spec of specs) {
        const now = await readState(page);
        if (unitById(now, spec.unitId) === undefined) break;
        await selectUnit(page, now, await cameraOf(page), spec.unitId);
        const buttons = groupButtons(page, spec.unitId, spec.group);
        if ((await buttons.count()) <= spec.index) continue;
        const control = buttons.nth(spec.index);
        const dispatched = await clickAndJudge(
          page,
          control,
          `seed ${String(seed)} unit ${String(spec.unitId)} ${spec.group} ${String(spec.index)}`,
          findings,
          records,
          await listedNow(page),
        );
        swept.push(
          `${spec.group}[${String(spec.index)}] "${spec.label}" -> ${dispatched ? 'dispatched' : 'nothing'}`,
        );
      }
    }
    // A unit controls nothing if this loop clicked nothing — and this file has already been fooled
    // once by exactly that, so it says so instead of passing quietly.
    expect(
      swept.length,
      `seed ${String(seed)}: the sweep clicked none of the units' controls`,
    ).toBeGreaterThan(0);

    // And then literally every button the page offers, dialogs included: the list is re-read on
    // every step, so controls that only exist once a dialog is open are reached in the same pass.
    //
    // **Disabled controls are skipped, and that is a correction with its evidence, not a
    // loosening.** A `disabled` control is not one the page *offers* — a player cannot click it,
    // so clicking it cannot be part of "no control the page offers dispatches a command the engine
    // refuses". Until the panels were given a layout region of their own (`styles.css`: the
    // dialogs are docked under the map instead of being laid out below the fold), this pass never
    // met one: the list shrinks to nine buttons early in the sweep — the selected unit runs out of
    // moves and the action group empties — so the loop broke out at `index >= count` before it
    // reached the city list, the tech opener or any dialog. Measured on the same seed and setup:
    // ten clicks, no dialog ever opened, no findings.
    //
    // Docking the panels moved their controls earlier in the DOM (the map column precedes the
    // panel column), so the same loop now walks the whole page — and meets the tech tree's locked
    // rows, which `techtree.ts` disables on `researchProblem`'s own verdict. `click()` waits for a
    // disabled control to become enabled, so each one burned the full 10 s actionability timeout:
    // 24 of them, three seeds, and the test died at its 420 s limit having proved nothing.
    //
    // What is genuinely lost is nothing: the property the old behaviour checked by accident — "a
    // control the engine would accept is not disabled" — is asserted where it can be asserted
    // properly and deterministically: `tech.spec.ts` (a locked row is disabled AND the engine
    // refuses it), the offered/reachable sweeps above, and the queried-setters pass below
    // ("enablement agrees with the engine"). What is gained is that this pass now reaches the
    // whole page instead of its first ten controls.
    let skippedDisabled = 0;
    await closeDialogs(page);
    let index = 0;
    let clicks = 0;
    while (index < MAX_SWEEP_CLICKS) {
      const buttons = page.getByRole('button');
      if (index >= (await buttons.count())) break;
      const control = buttons.nth(index);
      if (!(await control.isEnabled())) {
        skippedDisabled += 1;
        index += 1;
        continue;
      }
      await clickAndJudge(
        page,
        control,
        `seed ${String(seed)} page button ${String(index)}`,
        findings,
        records,
        await listedNow(page),
      );
      clicks += 1;
      index += 1;
    }
    expect(
      clicks,
      `seed ${String(seed)}: the page offered no enabled controls at all`,
    ).toBeGreaterThan(0);
    expect(
      clicks + skippedDisabled,
      `seed ${String(seed)}: the page offered no controls at all (clicks ${String(clicks)}, ` +
        `disabled ${String(skippedDisabled)})`,
    ).toBeGreaterThan(0);
  }

  const listed = records.filter((record) => LISTED_COMMANDS.has(actionType(record.action)));
  expect(records.length, 'the sweep dispatched nothing, so it proved nothing').toBeGreaterThan(20);
  expect(
    listed.length,
    'the sweep saw no listed command at all, so the membership half of the judgement was vacuous',
  ).toBeGreaterThan(0);
  expect(findings, `findings:\n${findings.join('\n')}`).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 2. KEYSTONE, THE REACHABLE DIRECTION
 * ------------------------------------------------------------------ */

test('adversarial keystone — reachable: every command the engine lists for a unit is offered by a control or by the map', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const findings: string[] = [];
  const records: DispatchRecords = [];

  for (const seed of [42, 1337] as const) {
    const state = await playToMidGame(page, seed);
    const units = unitsOf(state, humanPlayerId(state));
    expect(units.length, 'the mid-game position has no units to sweep').toBeGreaterThan(0);

    // The engine's list for each unit, taken on the position the sweep starts from.
    const expected = new Map<number, readonly unknown[]>();
    for (const unit of units) expected.set(unit.id, await actionsFor(page, { unitId: unit.id }));

    // (a) the controls, each one clicked on its OWN identical mid-game. One click may consume its
    // unit (founding a city takes the settler) or change what the next control offers (starting one
    // work order takes the other off the list), so a sweep that clicks down one list answers a
    // question about a game the engine is no longer being asked about. Every button is swept, chrome
    // included: this file is not entitled to assume which names are decorative.
    const specs: ControlSpec[] = [];
    for (const unit of units) specs.push(...(await controlsOf(page, unit.id)));
    expect(
      specs.length,
      `seed ${String(seed)}: the units offered no controls at all`,
    ).toBeGreaterThan(0);
    const silent: string[] = [];
    for (const spec of specs) {
      const fresh = await playToMidGame(page, seed);
      if (unitById(fresh, spec.unitId) === undefined) {
        findings.push(
          `unit ${String(spec.unitId)} is gone from a replay of the same seed, so its controls ` +
            'cannot be swept',
        );
        continue;
      }
      await selectUnit(page, fresh, await cameraOf(page), spec.unitId);
      const buttons = groupButtons(page, spec.unitId, spec.group);
      if ((await buttons.count()) <= spec.index) {
        findings.push(
          `unit ${String(spec.unitId)}'s ${spec.group} group had no control ${String(spec.index)} on a ` +
            'replay of the same seed',
        );
        continue;
      }
      const control = buttons.nth(spec.index);
      const label = (await control.innerText()).trim();
      const where = `seed ${String(seed)} unit ${String(spec.unitId)} ${spec.group} ${String(spec.index)}`;
      // Determinism, as a by-product: the same seed and the same script put the same control in the
      // same place with the same name. A difference here means the sweep is clicking something else.
      if (label !== spec.label) {
        findings.push(
          `${where}: the control read "${spec.label}" on the first game and "${label}" on a replay ` +
            'of the same seed',
        );
      }
      if (!(await clickAndJudge(page, control, where, findings, records, await listedNow(page)))) {
        silent.push(`${where} "${label}"`);
      }
    }
    expect(
      records.length,
      `seed ${String(seed)}: none of the units' controls dispatched anything ` +
        `(${String(silent.length)} dispatched nothing: ${silent.join(', ')})`,
    ).toBeGreaterThan(0);

    // (b) the map, for the destinations a player issues by clicking. A fresh position per target,
    // because a click that moves the unit makes the next target a different question.
    const reachableSet = (): ReadonlySet<string> =>
      new Set(records.map((record) => canonicalAction(record.action)));
    const missing = (): readonly unknown[] => {
      const found = reachableSet();
      const wanted: unknown[] = [];
      for (const list of expected.values()) {
        for (const action of list) {
          if (!LISTED_COMMANDS.has(actionType(action))) continue;
          if (!found.has(canonicalAction(action))) wanted.push(action);
        }
      }
      return wanted;
    };

    for (const action of missing()) {
      const type = actionType(action);
      const target = actionTarget(action);
      if (target === undefined) continue;
      if (type !== 'MoveUnit' && type !== 'AttackUnit') continue;
      const fresh = await playToMidGame(page, seed);
      // The unit that OWNED the action: a tile that one unit can reach is not necessarily one the
      // first unit in the list can, and clicking it with the wrong unit selected would dispatch the
      // wrong command (or a refusal) and report a reachability gap that is this test's own mistake.
      const unitId = actionUnitId(action);
      if (unitId === undefined) continue;
      if (unitById(fresh, unitId) === undefined) continue;
      await selectUnit(page, fresh, await cameraOf(page), unitId);
      await bringTileToCentre(page, await readState(page), target);
      const camera = await cameraOf(page);
      const box = await canvasBox(page);
      if (!visibleTiles(await readState(page), camera, box).includes(target)) {
        findings.push(
          `no ${type} to tile ${String(target)} could be driven from the map: the tile cannot be ` +
            `brought into the viewport`,
        );
        continue;
      }
      const issued = await clickTileOrder(page, camera, target, fresh.map.width, type);
      expect(issued, `clicking tile ${String(target)} did not issue a ${type}`).toBe(true);
      for (const entry of await dispatchLog(page)) {
        records.push({
          where: `seed ${String(seed)} map`,
          label: `tile ${String(target)}`,
          action: entry.action,
        });
      }
    }

    // (c) the reachable set must cover the engine's list. Enumerated commands only: `FortifyUnit`
    // is queried, and is absent from `unitActions` by the engine's own design.
    const reachable = reachableSet();
    const unreachable: string[] = [];
    for (const [unitId, list] of expected) {
      for (const action of list) {
        if (!LISTED_COMMANDS.has(actionType(action))) continue;
        if (!reachable.has(canonicalAction(action))) {
          unreachable.push(`unit ${String(unitId)}: ${JSON.stringify(action)}`);
        }
      }
    }
    expect(
      unreachable,
      `commands the engine lists that no control and no map click produced:\n${unreachable.join('\n')}`,
    ).toEqual([]);
  }

  expect(records.length, 'the sweep produced no commands at all').toBeGreaterThan(0);
  expect(findings, `findings:\n${findings.join('\n')}`).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 3. THE QUERIED SETTERS
 * ------------------------------------------------------------------ */

test('adversarial keystone — the queried setters: every setter the engine accepts has a control, and enablement agrees with the engine', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const findings: string[] = [];
  const records: DispatchRecords = [];

  await openApp(page);
  await seedApp(page, MID_GAME_SEED);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  const city = await foundCity(page);
  const owner = humanPlayerId(await readState(page));

  /* --- SetProduction: the city's own menu, in both directions --- */

  const engineMenu = new Set((await actionsFor(page, { cityId: city.id })).map(canonicalAction));
  await openCity(page, await readState(page), await cameraOf(page), city);
  const buildCount = await cityDialog(page, city.name)
    .getByRole('button', { name: /^Build / })
    .count();
  expect(buildCount, 'the city screen offers nothing to build').toBeGreaterThan(0);
  const offered = new Set<string>();
  for (let index = 0; index < buildCount; index += 1) {
    await openCity(page, await readState(page), await cameraOf(page), city);
    const control = cityDialog(page, city.name)
      .getByRole('button', { name: /^Build / })
      .nth(index);
    if ((await control.count()) === 0) continue;
    await clickAndJudge(
      page,
      control,
      `city build ${String(index)}`,
      findings,
      records,
      await listedNow(page),
    );
    for (const entry of await dispatchLog(page)) {
      if (actionType(entry.action) === 'SetProduction') offered.add(canonicalAction(entry.action));
    }
  }
  for (const action of offered) {
    if (!engineMenu.has(action)) {
      findings.push(`the city screen offers ${action}, which is not in the engine's menu`);
    }
  }
  for (const action of engineMenu) {
    if (!offered.has(action)) {
      findings.push(`the engine's menu offers ${action} and no control produces it`);
    }
  }

  /* --- SetWorkedTiles: the city's worked-tile controls --- */

  const boxCount = await cityDialog(page, city.name).getByRole('checkbox').count();
  expect(boxCount, 'the city screen offers no worked-tile controls').toBeGreaterThan(0);
  for (let index = 0; index < boxCount; index += 1) {
    await openCity(page, await readState(page), await cameraOf(page), city);
    const box = cityDialog(page, city.name).getByRole('checkbox').nth(index);
    if ((await box.count()) === 0) continue;
    if (!(await box.isEnabled())) continue;
    await clearDispatchLog(page);
    await box.click();
    for (const entry of await dispatchLog(page)) {
      records.push({
        where: `worked tile ${String(index)}`,
        label: 'checkbox',
        action: entry.action,
      });
      if (actionType(entry.action) !== 'SetWorkedTiles') {
        findings.push(
          `a worked-tile checkbox the UI enables dispatched ${JSON.stringify(entry.action)}, which ` +
            `is not a SetWorkedTiles command`,
        );
      } else if (entry.result !== 'ok') {
        findings.push(
          `a worked-tile checkbox the UI enables dispatched ${JSON.stringify(entry.action)} and the ` +
            `engine refused it`,
        );
      }
    }
  }
  await closeDialogs(page);

  /* --- SetResearch: the tech tree, and its disabled rows --- */

  const techs = await openPanel(page, /Technology/i);
  await expect(techs).toBeVisible();
  for (const tech of CATALOG.techs) {
    const button = techs
      .getByRole('button', { name: new RegExp(`^${escapeRegExp(tech.name)} \\(`) })
      .first();
    if ((await button.count()) === 0) {
      findings.push(`the tech tree has no row for ${tech.name}`);
      continue;
    }
    if (await button.isEnabled()) {
      await clearDispatchLog(page);
      await clickAndJudge(
        page,
        button,
        `tech row ${tech.name}`,
        findings,
        records,
        await listedNow(page),
      );
      for (const entry of await dispatchLog(page)) {
        if (actionType(entry.action) === 'SetResearch' && entry.result === 'ok') continue;
        findings.push(
          `the enabled tech row ${tech.name} dispatched ${JSON.stringify(entry.action)}`,
        );
      }
    } else {
      // The UI says no. The engine must say no too: a row the engine would accept and the UI
      // disables is an action the engine accepts that the UI cannot reach.
      const answer = await dispatch(page, { type: 'SetResearch', tech: tech.id });
      if (answer === 'ok') {
        findings.push(
          `the tech tree disables ${tech.name} and the engine accepts SetResearch for it`,
        );
      }
    }
  }
  await closeDialogs(page);

  /* --- SetRates: reachable, through the status strip's own rates control --- */

  // `SetRates` used to be the one queried setter with NO control anywhere in `packages/web/src`,
  // and this test pinned that gap as a recorded fact (`expect(unreachableQueried).toEqual(['SetRates'])`).
  // The gap is closed and the pin says so: the status strip — `panels/index.ts` — now carries a
  // `Tax rate`/`Science rate`/`Luxury rate` triple beside the treasury, beakers and luxuries it
  // feeds, and its `Set rates` button dispatches `SetRates` through the same seam every other
  // control uses. The rate space is still a SEARCH SPACE rather than a list, so the control
  // *enters* a triple and lets the engine judge every edit (`planSetRates`) instead of offering
  // each member the way the tech tree offers each tech — which is exactly why the engine's own
  // `legalActions` yields no `SetRates` either.
  //
  // The guard's purpose is unchanged and is now stronger: the list of queried setters with no
  // control must be EMPTY, and it may not pass vacuously, so the control is clicked here and the
  // command it dispatched is read back from the seam. A `SetRates` that came from anywhere else —
  // a test's own `dispatch`, say — would not be evidence that a player has a route to the engine,
  // and a new queried command with no control lands in this list and fails loudly.
  const started = headlessNewGame(
    MID_GAME_SEED,
    settingsFrom(await readSettings(page), MID_GAME_SEED),
  );
  expect(started.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (started.ok) {
    expect(
      planSetRates(started.value, RULESET, owner, { tax: 5, science: 5, luxury: 0 }).ok,
      'the engine refused a legal rates triple, so nothing below would prove anything',
    ).toBe(true);

    const ratesButton = page.getByRole('button', { name: /^Set rates/i });
    const rateControls = await ratesButton.count();
    expect(
      rateControls,
      'no `Set rates` control exists, so "SetRates is reachable" would be vacuous',
    ).toBeGreaterThan(0);

    await clearDispatchLog(page);
    await ratesButton.first().click();
    const ratesDispatched = (await dispatchLog(page)).filter(
      (entry) => actionType(entry.action) === 'SetRates',
    );
    expect(
      ratesDispatched.length,
      'the `Set rates` control dispatched no SetRates command at all',
    ).toBeGreaterThan(0);
    expect(
      ratesDispatched.every((entry) => entry.result === 'ok'),
      'the `Set rates` control dispatched a SetRates the engine refused, which is the keystone ' +
        'property broken at this panel',
    ).toBe(true);
    for (const entry of ratesDispatched) {
      records.push({ where: 'status strip', label: 'Set rates', action: entry.action });
    }

    /* --- SetGovernment: reachable, through M9's government selector --- */

    // The selector lists `governmentCatalog`'s rows and lets `planSetGovernment` — the evaluator
    // `applyCommand` refuses with — judge the click, so a control it enables is a command the
    // applier accepts. This is the same guard the `Set rates` block above applies, one panel over.
    const governmentButton = page.getByRole('button', { name: /^Set government$/ });
    expect(
      await governmentButton.count(),
      'no `Set government` control exists, so "SetGovernment is reachable" would be vacuous',
    ).toBeGreaterThan(0);
    await clearDispatchLog(page);
    await governmentButton.first().click();
    const governmentDispatched = (await dispatchLog(page)).filter(
      (entry) => actionType(entry.action) === 'SetGovernment',
    );
    expect(
      governmentDispatched.length,
      'the `Set government` control dispatched no SetGovernment command at all',
    ).toBeGreaterThan(0);
    expect(
      governmentDispatched.every((entry) => entry.result === 'ok'),
      'the `Set government` control dispatched a SetGovernment the engine refused, which is the ' +
        'keystone property broken at this panel',
    ).toBe(true);
    for (const entry of governmentDispatched) {
      records.push({ where: 'status strip', label: 'Set government', action: entry.action });
    }

    const reached = new Set(records.map((record) => actionType(record.action)));
    const unreachableQueried = QUERIED_SETTERS.filter((type) => !reached.has(type));
    expect(
      unreachableQueried,
      'a queried setter has no control: this list is the recorded gap between the engine and the ' +
        'UI, and every member is a command the engine accepts that a player cannot reach',
    ).toEqual([]);
  }

  expect(findings, `findings:\n${findings.join('\n')}`).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 4. NO RULES IN THE UI
 * ------------------------------------------------------------------ */

interface ScannedLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly bucket: string;
}

/**
 * Strip everything in a line that cannot be a rule computation: comments, string literals and
 * template interpolations. A label may *print* an engine figure; what matters is whether the line
 * *computes* one. What is left is code, and code that combines a rule-shaped word with arithmetic
 * is what the scan looks for.
 */
const codeWithoutLiterals = (line: string): string =>
  line
    .replace(/\/\/.*$/, '')
    .replace(/\$\{[^}]*\}/g, '${}')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

const RULE_WORD =
  /(cost|shields?|yield|food|gold|tax|science|luxury|hitpoint|attack|defen[cs]e|movement|production|research|growth|population|treasury|beakers?)/i;
/**
 * An operator with **code on both sides** — `total + city.population`, not `\u2026 movement left` +.
 *
 * The first version of this scan asked only whether an operator appeared on the line, and it
 * reported two string concatenations (a template literal continued by a `+`, and a log line built
 * by `+`) as if they were rules arithmetic. An operator whose left operand is a quote or whose right
 * operand is a line end is joining text, which is presentation; one whose operands are identifiers,
 * calls or literals is computing something, which is what this scan is about.
 */
const ARITHMETIC = /[\w)\]]\s*[+\-*/%]\s*[\w([{]/;

/**
 * The allowlist, written as **reasons** rather than as line numbers: a new rule computation in the
 * UI has to be either removed or added here with a reason, which is the point of scanning rather
 * than trusting review.
 */
const allowedBecause = (file: string, line: string): string | undefined => {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (/^\s*(\*|\/\/|\/\*)/.test(line)) return 'comment';
  if (/^\s*(import\b|\} from|export \{)/.test(line.trim())) return 'module list';
  // A label that PRINTS engine figures and joins them with `+`: the operands are string literals
  // and engine calls, and the values come from the engine (`eventLines` is the log's only author).
  if (
    /`[^`]*`\s*\+\s*$/.test(line) &&
    /String\(|Label\(|\.(name|tileText|hitPoints)\b/.test(line)
  ) {
    return 'string concatenation of engine-provided labels';
  }
  // The renderer and the projection: geometry and colour only. Their freedom from engine
  // quantities is asserted separately below, not taken on trust here.
  if (base === 'render.ts' || base === 'view.ts') return 'renderer/projection geometry and colour';
  // The scoreboard's aggregate: a sum over STORED fields (`city.population`, unit counts), with no
  // terrain, no catalog and no yield consulted — named in `scoreboard.ts`'s own module note, and
  // checked against the state by the panels spec.
  if (
    base === 'scoreboard.ts' &&
    /\.reduce\(\(total, city\) => total \+ city\.population, 0\)/.test(line)
  ) {
    return 'scoreboard aggregate over stored fields (no terrain, no catalog)';
  }
  // A sign prefix on a figure the engine computed: `5 (+1 per turn)`.
  if (/foodSurplus >= 0 \? '\+' : ''/.test(line)) return 'sign prefix on an engine figure';
  return undefined;
};

test('no rules in the UI: every rule-shaped line in packages/web/src is classified, and none of them computes a rule', async ({
  page,
}) => {
  // The scan is of the app that is running, so the app had better be running.
  await openApp(page);
  await expectReady(page);

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(SOURCE_ROOT);
  expect(files.length, 'the scan found no source files, so it proved nothing').toBeGreaterThan(5);

  const scanned: ScannedLine[] = [];
  const unclassified: ScannedLine[] = [];
  for (const file of files) {
    const name = file.slice(SOURCE_ROOT.length + 1);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = codeWithoutLiterals(line);
      if (!RULE_WORD.test(code) || !ARITHMETIC.test(code)) return;
      const why = allowedBecause(name, line);
      const entry: ScannedLine = {
        file: name,
        line: index + 1,
        text: line.trim(),
        bucket: why ?? 'UNCLASSIFIED',
      };
      scanned.push(entry);
      if (why === undefined) unclassified.push(entry);
    });
  }

  // The renderer and the projection may not name a rule quantity at all, whatever they compute: the
  // projection is geometry, and a second copy of a rule in it is the drift §Rendering bans.
  const engineWords = /(yield|shields?|cost|attack|defen[cs]e|movement|production|research)/i;
  const rendererReads: string[] = [];
  for (const name of ['render.ts', 'view.ts'] as const) {
    const text = readFileSync(join(SOURCE_ROOT, name), 'utf8');
    text.split('\n').forEach((line, index) => {
      // Prose is not a read: a module note may *say* "no rule, no yield" — that is the claim, not a
      // violation of it. What is checked is code that names an engine quantity.
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
      if (engineWords.test(codeWithoutLiterals(line))) {
        rendererReads.push(`${name}:${String(index + 1)}: ${line.trim()}`);
      }
    });
  }

  const report = [
    'packages/web/src — every line combining a rule-shaped word with arithmetic:',
    ...scanned.map(
      (entry) =>
        `  ${entry.file}:${String(entry.line)} [${entry.bucket}] ${entry.text.slice(0, 140)}`,
    ),
    `  (${String(scanned.length)} lines in total, ${String(unclassified.length)} unclassified; ` +
      `${String(files.length)} files scanned)`,
  ].join('\n');
  process.stdout.write(`\n${report}\n`);

  expect(
    unclassified.map((entry) => `${entry.file}:${String(entry.line)}: ${entry.text}`),
    `lines in the UI that combine a rule-shaped word with arithmetic and carry no recorded reason:\n${report}`,
  ).toEqual([]);
  expect(
    rendererReads,
    `the renderer or the projection names an engine quantity:\n${rendererReads.join('\n')}`,
  ).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 5. THE UI CANNOT DIVERGE
 * ------------------------------------------------------------------ */

test('the UI cannot diverge: after a command the panels, the log text and the draw trace agree with the new state', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const findings: string[] = [];

  await openApp(page);
  await seedApp(page, MID_GAME_SEED);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  await clearDispatchLog(page);

  // The engine's own game for this seed and these settings, started in this process.
  const started = headlessNewGame(
    MID_GAME_SEED,
    settingsFrom(await readSettings(page), MID_GAME_SEED),
  );
  expect(started.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (!started.ok) return;
  const owner = humanPlayerId(await readState(page));
  expect(
    await stateHash(page),
    'the browser is not the game the engine starts for this seed and these settings',
  ).toBe(hashOf(started.value));

  // Play through the UI's OWN controls, recording what each click dispatched: a city founded from
  // the settler's control, a warrior started from the city screen's menu, three turns from the
  // `End turn` button. Then the same commands, through the real applier, in this process.
  const city = await foundCity(page);
  await openCity(page, await readState(page), await cameraOf(page), city);
  const warrior = cityDialog(page, city.name).getByRole('button', { name: /^Build Warrior / });
  expect(await warrior.count(), 'the city menu has no Warrior to build').toBeGreaterThan(0);
  await warrior.first().click();
  await closeDialogs(page);
  await endTurns(page, 3);

  const played: unknown[] = [];
  for (const entry of await dispatchLog(page)) {
    if (entry.result === 'ok') played.push(entry.action);
  }
  expect(
    played.length,
    'the UI played no commands, so the comparison would be vacuous',
  ).toBeGreaterThan(0);
  const replayed = replayScript(started.value, owner, played);
  expect(
    await stateHash(page),
    `the UI and the engine disagree after the same ${String(played.length)} commands: ` +
      `${await stateHash(page)} vs ${hashOf(replayed)}`,
  ).toBe(hashOf(replayed));

  // One more command, issued by the control a player presses, whose events the engine also renders
  // here — so the log is checked against the engine's own prose rather than against the DOM.
  const linesBefore = (await eventLog(page).getByRole('listitem').allInnerTexts()).map((line) =>
    line.trim(),
  );
  await endTurnButton(page).click();
  const applied = applyCommand(replayed, owner, { type: 'EndTurn' }, RULESET);
  expect(applied.ok, 'the engine refused the End turn the control issued').toBe(true);
  if (!applied.ok) return;

  const after = await readState(page);
  expect(
    await stateHash(page),
    'the panels are showing a state the engine does not derive from the same commands',
  ).toBe(hashOf(applied.value.state));
  expect(after.revision).toBe(applied.value.state.revision);

  /* --- the panels --- */

  await expect(turnIndicator(page)).toContainText(`Turn ${String(after.turn)}`);
  await expect(yearIndicator(page)).toBeVisible();
  const player = humanPlayer(after);
  await expect(treasuryIndicator(page)).toContainText(String(player.treasury));
  await expect(scienceIndicator(page)).toContainText(String(player.beakers));
  await expect(luxuryIndicator(page)).toContainText(String(player.luxuries));

  const rows = await scoreboard(page).locator('tbody tr').allInnerTexts();
  expect(rows.length, 'the scoreboard lost a player').toBe(after.players.length);
  for (const other of after.players) {
    const row = rows.find((candidate) => candidate.includes(other.name));
    expect(row, `the scoreboard has no row for ${other.name}`).toBeDefined();
    if (row === undefined) continue;
    const cities = after.cities.filter((candidate) => candidate.owner === other.id).length;
    const units = unitsOf(after, other.id).length;
    if (!row.includes(String(cities)) || !row.includes(String(units))) {
      findings.push(
        `the scoreboard row for ${other.name} does not carry the state's counts (cities ` +
          `${String(cities)}, units ${String(units)}): "${row}"`,
      );
    }
  }

  const cityRows = await page
    .getByRole('list', { name: 'Cities' })
    .getByRole('button')
    .allInnerTexts();
  const mine = after.cities.filter((candidate) => candidate.owner === owner);
  expect(cityRows.length, 'the Cities list is not the seat’s own cities').toBe(mine.length);
  for (const entry of mine) {
    if (!cityRows.some((text) => text.includes(entry.name))) {
      findings.push(`the Cities list does not name ${entry.name}, which the state holds`);
    }
  }

  const unitText = await unitPanel(page).innerText();
  for (const unit of unitsOf(after, owner)) {
    if (!unitText.includes(String(unit.id))) {
      findings.push(`the Units region does not name unit ${String(unit.id)}`);
    }
  }

  const hashShown = await stateHashIndicator(page).innerText();
  if (!hashShown.includes(hashOf(applied.value.state))) {
    findings.push(
      `the Debug panel shows "${hashShown}" while the engine's state hashes to ` +
        hashOf(applied.value.state),
    );
  }

  /* --- the event log, against the engine's own rendering of the same events --- */

  const logLines = (await eventLog(page).getByRole('listitem').allInnerTexts()).map((line) =>
    line.trim(),
  );
  const expectedLines = eventLines(applied.value.events, {
    state: applied.value.state,
    ruleset: RULESET,
  });
  for (const line of expectedLines) {
    if (!logLines.some((shown) => shown === line.trim())) {
      findings.push(`the log does not carry the engine's own line "${line}"`);
    }
  }
  if (logLines.length - linesBefore.length !== expectedLines.length) {
    findings.push(
      `the command produced ${String(expectedLines.length)} engine event line(s) and the log grew ` +
        `by ${String(logLines.length - linesBefore.length)}`,
    );
  }
  for (let index = 0; index < linesBefore.length; index += 1) {
    if (logLines[index] !== linesBefore[index]) {
      findings.push(`the log rewrote its own history at line ${String(index + 1)}`);
      break;
    }
  }

  /* --- the draw trace, against the state --- */

  const trace = await drawTraceOf(page, after.map.width);
  expect(trace.length, 'the draw trace is empty, so its agreement proved nothing').toBeGreaterThan(
    0,
  );
  const drawn = new Set(trace.map((entry) => entry.tile));
  for (const entry of trace) {
    const terrain = terrainAtTile(after, entry.tile);
    if (entry.terrain !== terrain) {
      findings.push(
        `the draw trace painted tile ${String(entry.tile)} as ${entry.terrain} while the state says ${terrain}`,
      );
    }
  }
  const camera = await cameraOf(page);
  const box = await canvasBox(page);
  for (const tile of visibleTiles(after, camera, box)) {
    if (!drawn.has(tile)) {
      findings.push(`tile ${String(tile)} is inside the viewport and was not drawn`);
    }
  }

  expect(findings, `findings:\n${findings.join('\n')}`).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 6. DETERMINISM ACROSS TWO BROWSER CONTEXTS
 * ------------------------------------------------------------------ */

/** The command a step picks, from the engine's own lists by a rule that reads only the state. */
const chooseStep = async (page: Page, step: number): Promise<unknown> => {
  const state = await readState(page);
  if (step === 3) {
    const city = state.cities[0];
    if (city !== undefined) {
      const options = await actionsFor(page, { cityId: city.id });
      if (options.length > 0) return options[step % options.length];
    }
  }
  for (const unit of unitsOf(state, humanPlayerId(state))) {
    const actions = await actionsFor(page, { unitId: unit.id });
    const notEndTurn = actions.filter((action) => actionType(action) !== 'EndTurn');
    if (notEndTurn.length > 0) return notEndTurn[step % notEndTurn.length];
  }
  return 'end-turn';
};

test('determinism: one seed and one script hash the same in two browser contexts and in the headless engine', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const seed = 20260214;
  const SCRIPT_LENGTH = 14;

  interface Run {
    readonly script: readonly unknown[];
    readonly hash: string;
    readonly state: UiState;
    readonly settings: unknown;
  }

  /** Play the script in a context of its own, and report what it dispatched. */
  const run = async (): Promise<Run> => {
    // A context of its own: no cookie, no storage, no page, no frame counter shared with the first
    // run. Whatever comes back is a function of the seed and the script alone.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await openApp(page);
    await seedApp(page, seed);
    expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
    await clearDispatchLog(page);

    const script: unknown[] = [];
    for (let step = 0; step < SCRIPT_LENGTH; step += 1) {
      const choice = await chooseStep(page, step);
      if (choice === 'end-turn') await endTurnButton(page).click();
      else {
        const answer = await dispatch(page, choice);
        expect(answer, `step ${String(step)}: ${JSON.stringify(choice)} was refused`).toBe('ok');
      }
      for (const entry of await dispatchLog(page)) {
        if (entry.result === 'ok') script.push(entry.action);
      }
      await clearDispatchLog(page);
    }

    const hash = await stateHash(page);
    const state = await readState(page);
    const settings = await readSettings(page);
    await context.close();
    return { script, hash, state, settings };
  };

  const first = await run();
  const second = await run();

  expect(
    first.script.length,
    'the script is empty, so the equality would be vacuous',
  ).toBeGreaterThan(0);
  // The second run must have been driven by the SAME script: otherwise this compares two different
  // games that happen to agree rather than one game played twice.
  expect(second.script.map(canonicalAction)).toEqual(first.script.map(canonicalAction));
  expect(
    second.hash,
    `two contexts, one seed and one script disagreed: ${first.hash} vs ${second.hash}`,
  ).toBe(first.hash);

  // And the engine, headless, on the script the browser actually dispatched.
  const started = headlessNewGame(seed, settingsFrom(first.settings, seed));
  expect(started.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (!started.ok) return;
  const replayed = replayScript(started.value, humanPlayerId(first.state), first.script);
  expect(
    hashOf(replayed),
    `the browser produced ${first.hash} and the engine ${hashOf(replayed)} for the same script`,
  ).toBe(first.hash);
  expect(replayed.turn).toBe(first.state.turn);
  expect(replayed.units.length).toBe(first.state.units.length);
  expect(replayed.cities.length).toBe(first.state.cities.length);
  expect(replayed.revision).toBe(first.state.revision);
});

/* ------------------------------------------------------------------ *
 * 7. SAVE / LOAD INTEGRITY
 * ------------------------------------------------------------------ */

const SAVE_KEY = 'civts.save.v1';

const readSave = (page: Page): Promise<string | null> =>
  page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);

const writeSave = (page: Page, text: string): Promise<void> =>
  page.evaluate(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: SAVE_KEY, value: text },
  );

const saveStatus = (page: Page): Promise<string> =>
  page.getByRole('status', { name: 'Save status' }).innerText();

/** A comparable key for a state, so "is this the same world" is one string comparison. */
const stateKey = (state: unknown): string => JSON.stringify(state);

test('save/load integrity: a payload whose state does not hash to its recorded hash is refused, and nothing is adopted', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const findings: string[] = [];

  await openApp(page);
  await seedApp(page, MID_GAME_SEED);
  await foundCity(page);
  await endTurns(page, 3);

  // The moment of saving: this hash is what a load must reproduce exactly.
  const savedHash = await stateHash(page);
  await saveButton(page).click();
  const payload = await readSave(page);
  expect(payload, 'Save game wrote nothing to localStorage').not.toBeNull();
  if (payload === null) return;
  const parsed: unknown = JSON.parse(payload);
  expect(isRecord(parsed), 'the save payload is not an object').toBe(true);
  if (!isRecord(parsed)) return;
  expect(parsed['hash'], 'the save does not record the hash of the state it stores').toBe(
    savedHash,
  );

  // Mutate the game, then load: the state must come back exactly as it was saved.
  await endTurns(page, 2);
  const mutatedHash = await stateHash(page);
  expect(
    mutatedHash,
    'ending turns did not change the game, so the round trip would be vacuous',
  ).not.toBe(savedHash);
  await page.getByRole('button', { name: 'Load game' }).click();
  expect(await stateHash(page), 'loading the save did not restore the state that was saved').toBe(
    savedHash,
  );
  const loadedState = await readState(page);

  // A payload whose `state` is a REAL state but whose recorded hash belongs to a different one: the
  // shape a corrupt or hand-edited save has, and the one that would install a wrong world if the
  // app trusted the file. The app must fail closed.
  const savedStateKey = stateKey(loadedState);
  await seedApp(page, 7);
  const seventhState = await page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the seam is missing');
    return JSON.parse(JSON.stringify(api.state())) as unknown;
  });
  expect(stateKey(seventhState), 'the two saves hold the same world').not.toBe(savedStateKey);

  await writeSave(page, JSON.stringify({ schema: 1, hash: savedHash, state: seventhState }));
  const beforeMismatch = await stateHash(page);
  await page.getByRole('button', { name: 'Load game' }).click();
  const afterMismatch = await stateHash(page);
  if (afterMismatch !== beforeMismatch) {
    findings.push(
      `a save whose state does not hash to its recorded hash was adopted: ${beforeMismatch} became ` +
        `${afterMismatch}, while the file claimed ${savedHash}`,
    );
  }
  const mismatchStatus = await saveStatus(page);
  if (!/failed/i.test(mismatchStatus)) {
    findings.push(`the app did not report the refused load: the status says "${mismatchStatus}"`);
  }

  // Malformed JSON, and no save at all: neither may be adopted, and both must be reported.
  await writeSave(page, '{"schema":1,"hash":"deadbeefdeadbeef","state":');
  const beforeMalformed = await stateHash(page);
  await page.getByRole('button', { name: 'Load game' }).click();
  if ((await stateHash(page)) !== beforeMalformed) {
    findings.push('a save that is not even JSON was adopted');
  }
  const malformedStatus = await saveStatus(page);
  if (!/failed/i.test(malformedStatus)) {
    findings.push(`the malformed save was not reported: the status says "${malformedStatus}"`);
  }

  await page.evaluate((key) => {
    window.localStorage.removeItem(key);
  }, SAVE_KEY);
  const beforeAbsent = await stateHash(page);
  await page.getByRole('button', { name: 'Load game' }).click();
  if ((await stateHash(page)) !== beforeAbsent) {
    findings.push('loading with no save in storage changed the state');
  }
  const absentStatus = await saveStatus(page);
  if (!/failed/i.test(absentStatus)) {
    findings.push(`loading with no save was not reported: the status says "${absentStatus}"`);
  }

  // The surviving state is still the game its seed and settings describe: not a half-installed one.
  const started = headlessNewGame(7, settingsFrom(await readSettings(page), 7));
  expect(started.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (started.ok) {
    expect(
      await stateHash(page),
      'the app is no longer the game its seed and settings describe',
    ).toBe(hashOf(started.value));
    expect((await readState(page)).revision).toBe(started.value.revision);
  }

  expect(findings, `findings:\n${findings.join('\n')}`).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 8. PIXEL TESTS ARE NOT VACUOUS
 * ------------------------------------------------------------------ */

test('pixel sampling is not vacuous: the tile-colour predicate separates the terrains and rejects a uniform image', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openApp(page);
  await seedApp(page, MID_GAME_SEED);
  const state = await readState(page);
  const owner = humanPlayerId(state);
  const camera = await cameraOf(page);
  const box = await canvasBox(page);
  const palette = await paletteOf(page);
  expect(palette, 'the app exposes no terrain palette, so no colour can be checked').toBeDefined();
  if (palette === undefined) return;

  /** For each terrain, the colour the app says it paints and the colour a tile actually carries. */
  const samples = new Map<string, string>();
  const mismatches: string[] = [];
  let sampled = 0;
  for (const tile of visibleTiles(state, camera, box)) {
    if (sampled >= 60) break;
    // Three reasons a tile's centre is not a terrain reading: it is unexplored (the renderer paints
    // fog there, deliberately), it holds a unit or a city (a marker is painted on it), or its centre
    // is outside the canvas (a sample there is not a sample of the map).
    if (!isExplored(state, owner, tile)) continue;
    if (!tileIsClear(state, tile)) continue;
    const x = tileX(state, tile);
    const y = tileY(state, tile);
    const local = tileCentre(camera, x, y);
    if (local.x < 0 || local.y < 0 || local.x >= box.width || local.y >= box.height) continue;
    const terrain = terrainAtTile(state, tile);
    const wanted = palette[terrain];
    if (wanted === undefined) {
      mismatches.push(`tile ${String(tile)}: the palette has no colour for ${terrain}`);
      continue;
    }
    const painted = await sampleTileColour(page, camera, x, y);
    sampled += 1;
    const expected = parseHexColour(wanted);
    if (colourDistance(painted, expected) > 8) {
      mismatches.push(
        `tile ${String(tile)} (${terrain}): painted ${describeColour(painted)}, the palette says ${wanted}`,
      );
      continue;
    }
    if (!samples.has(terrain)) samples.set(terrain, describeColour(painted));
  }

  expect(sampled, 'no tile was sampled, so the pixel check proved nothing').toBeGreaterThan(0);
  expect(mismatches, `pixels disagree with the palette:\n${mismatches.join('\n')}`).toEqual([]);
  expect(
    samples.size,
    `only ${String(samples.size)} terrain kind(s) were on screen: a palette check that cannot ` +
      'separate two terrains is not a check',
  ).toBeGreaterThan(1);

  // The control: the same reading, on an image that is deliberately broken — every pixel the same
  // colour. Two points that lie on different terrains in the real frame must come back identical,
  // which is what makes a green run on the real canvas evidence rather than decoration.
  const uniformVerdict = await page.evaluate((hex) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.fillStyle = hex;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const read = (x: number, y: number): string => {
      const data = context.getImageData(x, y, 1, 1).data;
      return `${String(data[0] ?? 0)},${String(data[1] ?? 0)},${String(data[2] ?? 0)}`;
    };
    return { first: read(4, 4), second: read(28, 28) };
  }, '#4a9d4a');
  expect(uniformVerdict, 'the page could not build the control image').not.toBeNull();
  if (uniformVerdict !== null) {
    expect(
      uniformVerdict.first,
      'the control image is not uniform, so the control proved nothing',
    ).toBe(uniformVerdict.second);
    // And the palette itself must be able to tell two terrains apart: a palette of one colour would
    // make every colour assertion above vacuous however many tiles were sampled.
    const colours = new Set(Object.values(palette));
    expect(colours.size, 'every terrain is painted the same colour').toBeGreaterThan(1);
  }
});

/* ------------------------------------------------------------------ *
 * 9. ADVISORY SCREENSHOTS
 * ------------------------------------------------------------------ */

test('advisory evidence: a played game is captured at its start and mid-game, with the city, the tech tree, the log and the debug panel', async ({
  page,
}) => {
  test.setTimeout(300_000);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  // Every frame is captured from the top of the page: a screenshot taken after Playwright scrolled
  // to reach a control reviews a scrolled window and hides the map, which is the panel a reviewer
  // most wants to see. (The first version of this test captured exactly that.)
  const shoot = async (name: string): Promise<void> => {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: join(ARTIFACT_DIR, name) });
  };

  await openApp(page);
  await expectReady(page);
  await shoot('01-start.png');

  const state = await seedApp(page, MID_GAME_SEED);
  const city = await foundCity(page);
  await endTurns(page, 4);

  await openCity(page, await readState(page), await cameraOf(page), city);
  await shoot('02-city-mid-game.png');
  await closeDialogs(page);

  const techs = await openPanel(page, /Technology/i);
  await expect(techs).toBeVisible();
  await shoot('03-tech-tree.png');
  await closeDialogs(page);

  await shoot('04-event-log.png');

  const debug = await openPanel(page, /Debug/i);
  await expect(debug).toBeVisible();
  await shoot('05-debug.png');

  // The screenshots are advisory evidence, never the assertion — but the frames they capture must
  // be frames of a game that is still agreed on, so they are not pictures of a broken screen.
  const hash = await stateHash(page);
  await expect(stateHashIndicator(page)).toContainText(hash);
  expect((await readState(page)).turn, 'the captured frame is not a played game').toBeGreaterThan(
    state.turn,
  );

  const files = readdirSync(ARTIFACT_DIR).filter((name) => name.endsWith('.png'));
  expect(files.length, 'no screenshot was written').toBeGreaterThanOrEqual(5);
});
