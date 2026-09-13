/**
 * M9+M10's browser surface: borders, the city screen's culture and happiness, the government
 * selector, the score column and the victory/defeat screen.
 * See docs/INTERFACES.md, M9+M10 ("The UI", "Victory and score", "Culture", "Borders",
 * "Governments", "Happiness") and the M8 section it inherits (the test seam, the accessibility
 * contract, "the UI must not contain game rules").
 *
 * ## What every assertion here is against
 *
 * Three authorities, and never a guess:
 *
 * - **the engine's own state**, through the frozen seam (`window.__CIVTS__`): the ownership layer a
 *   border paints is `state.tileOwner` as the ENGINE holds it, never a border recomputed here from
 *   cities and culture;
 * - **the app's own projection** (`src/view.ts`) for every screen coordinate, so a pixel sample
 *   lands where the renderer painted and not where this file imagines it did;
 * - **the same engine, replayed headlessly** for every figure a panel prints. The browser IS the
 *   engine host, so "the city screen shows 2 happy citizens" is checked against `happinessOf` on a
 *   headless state built from the same seed and the same script — and `stateHash()` is compared
 *   FIRST, so a comparison against a different board cannot pass.
 *
 * ## The names this milestone adds, all role + accessible name
 *
 * `combobox`/`Government`, `button`/`Set government` and `status`/`Government verdict` (M9's
 * selector); `dialog`/`Game over` with `button`/`Show outcome` and `button`/`Close outcome` (M10's
 * outcome screen); the `Score` columnheader in the existing `Scoreboard` table; and the `Culture`,
 * `Happiness` and `Disorder` facts in the existing `City <name>` dialog. None collides with a name
 * in the frozen M8 table, and `docs/INTERFACES.md`' M8 section is NOT edited — the names are stated
 * beside their panels in `packages/web/src/panels/*.ts`, which is what the M9 contract asks for.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  applyCommand,
  governmentCatalog,
  happinessOf,
  outcomeFor,
  playerCulture,
  scoreHorizon,
  scoreTable,
  type GameState,
} from '@civts/core';

import {
  cameraOf,
  canvasBox,
  clearDispatchLog,
  closeDialogs,
  colourDistance,
  describeColour,
  dispatch,
  dispatchLog,
  drawTraceOf,
  endTurnButton,
  foundCity,
  hashOf,
  headlessNewGame,
  humanPlayerId,
  openApp,
  openCity,
  openPanel,
  parseHexColour,
  readSettings,
  recordDispatches,
  readState,
  RULESET,
  sampleCanvasPixel,
  scoreboard,
  seedApp,
  settingsFrom,
  stateHash,
  tileX,
  tileY,
} from './helpers.js';
import { tileScreenPx, tileToScreen } from '../src/view.js';

/** A fixed seed, so every claim below is reproducible. */
const SEED = 9091;

/** The outcome screen, by its contractual name. */
const gameOverDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Game over' });

/** M9's government selector, by its three contractual names. */
const governmentMenu = (page: Page): Locator => page.getByRole('combobox', { name: 'Government' });
const governmentButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Set government' });
const governmentVerdict = (page: Page): Locator =>
  page.getByRole('status', { name: 'Government verdict' });

/** One labelled figure on the city screen: the `dd` that follows the `dt` named `label`. */
const cityFact = async (dialog: Locator, label: string): Promise<string> => {
  const labels = await dialog.locator('dt').allInnerTexts();
  const index = labels.indexOf(label);
  expect(
    index,
    `the city screen has no fact named ${label}; it has ${labels.join(', ')}`,
  ).toBeGreaterThanOrEqual(0);
  const values = await dialog.locator('dd').allInnerTexts();
  const value = values[index];
  expect(value, `the city screen's ${label} fact has no value`).toBeDefined();
  return value ?? '';
};

/**
 * Replay the script this suite drives through the UI, through the engine alone: the opening, a city
 * founded by the acting seat's first settler, and `turns` end-turn commands.
 *
 * The same technique `panel-usability.spec.ts` uses to read the ENGINE's own answer for a position
 * the browser is showing. The caller compares `stateHash()` against `hashOf(...)` first, so every
 * value read off the returned state is a value about the browser's game and not about a similar one.
 */
const replayHeadless = async (page: Page, turns: number): Promise<GameState> => {
  const settings = settingsFrom(await readSettings(page), SEED);
  const started = headlessNewGame(SEED, settings);
  expect(started.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (!started.ok) throw new Error('unreachable: the engine start was asserted above');
  const owner = humanPlayerId(await readState(page));
  const settler = started.value.units.find(
    (unit) => unit.owner === owner && unit.type.includes('settler'),
  );
  expect(settler, 'the headless game has no settler for the acting seat').toBeDefined();
  if (settler === undefined) throw new Error('unreachable: the settler was asserted above');

  const founded = applyCommand(
    started.value,
    owner,
    { type: 'FoundCity', unitId: settler.id },
    RULESET,
  );
  expect(founded.ok, 'the engine refused the city the UI founded').toBe(true);
  if (!founded.ok) throw new Error('unreachable: the found-city command was asserted above');

  let state: GameState = founded.value.state;
  for (let turn = 0; turn < turns; turn += 1) {
    const ended = applyCommand(state, owner, { type: 'EndTurn' }, RULESET);
    expect(ended.ok, `the engine refused end-turn ${String(turn + 1)}`).toBe(true);
    if (!ended.ok) throw new Error('unreachable: the end-turn command was asserted above');
    state = ended.value.state;
  }
  return state;
};

/* ------------------------------------------------------------------ *
 * 1. BORDERS
 * ------------------------------------------------------------------ */

test('M9 borders: the draw trace reports the engine’s own ownership layer, tile for tile', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  const city = await foundCity(page);
  await closeDialogs(page);
  const state = await readState(page);
  const owner = humanPlayerId(state);
  expect(
    state.tileOwner.length,
    'the state carries no ownership layer, so nothing about borders could be tested',
  ).toBe(state.map.width * state.map.height);

  // Read AFTER founding the city, because the layer is the engine's: a fresh game owns nothing
  // anywhere, so a comparison there would be vacuous.
  const claimed = state.tileOwner.filter((entry) => entry !== -1);
  expect(claimed.length, 'the founded city claims no tile at all').toBeGreaterThan(0);
  expect(
    claimed.every((entry) => entry === owner),
    'a tile is owned by a player other than the seat that founded the only city',
  ).toBe(true);
  expect(city.owner).toBe(owner);

  const trace = await drawTraceOf(page, state.map.width);
  expect(trace.length, 'the frame drew nothing').toBeGreaterThan(0);

  const width = state.map.width;
  const ownerOn = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= state.map.height) return -1;
    return state.tileOwner[y * width + x] ?? -1;
  };

  let bordered = 0;
  for (const entry of trace) {
    const layerValue = state.tileOwner[entry.tile];
    expect(
      layerValue,
      `the trace names tile ${String(entry.tile)}, which is not on the map`,
    ).toBeDefined();
    const expected = layerValue === undefined || layerValue === -1 ? null : layerValue;
    expect(
      entry.owner,
      `the trace says tile ${String(entry.tile)} is owned by ${String(entry.owner)} and the ` +
        `engine's own layer says ${String(layerValue)}`,
    ).toBe(expected);

    // A border is drawn exactly where ownership changes on an EXPLORED tile. `render.ts` explains
    // why fog wins: painting a rival's territory the player has never seen would reveal through the
    // border what the flat fog colour refuses to reveal through the terrain.
    const explored = state.explored[owner]?.[entry.tile] === true;
    const foreignEdge =
      expected !== null &&
      explored &&
      (ownerOn(entry.x - 1, entry.y) !== expected ||
        ownerOn(entry.x + 1, entry.y) !== expected ||
        ownerOn(entry.x, entry.y - 1) !== expected ||
        ownerOn(entry.x, entry.y + 1) !== expected);
    expect(
      entry.border,
      `tile ${String(entry.tile)} (owner ${String(expected)}, explored ${String(explored)})`,
    ).toBe(foreignEdge);
    if (entry.border) bordered += 1;
  }

  expect(
    bordered,
    'no drawn tile carries a border, so the frame never painted the ownership layer it reports',
  ).toBeGreaterThan(0);
});

test('M9 borders: the tint reaches the canvas in the owner’s colour, and the tile’s centre stays terrain', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  await closeDialogs(page);
  const state = await readState(page);
  const owner = humanPlayerId(state);
  const player = state.players.find((candidate) => candidate.id === owner);
  expect(player, 'the acting seat is not in the state').toBeDefined();
  if (player === undefined) return;

  // The colour comes from the STATE — the same thing the renderer's `ownerColour` lookup reads —
  // rather than from a swatch invented in this file.
  const expected = parseHexColour(player.color);
  const camera = await cameraOf(page);
  const size = tileScreenPx(camera);
  const band = Math.max(2, Math.round(size / 8));
  const box = await canvasBox(page);
  const width = state.map.width;

  const ownerOn = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= state.map.height) return -1;
    return state.tileOwner[y * width + x] ?? -1;
  };
  const busy = new Set<number>([
    ...state.units.map((unit) => unit.tile),
    ...state.cities.map((candidate) => candidate.tile),
  ]);

  interface Sample {
    readonly tile: number;
    readonly edge: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly centre: { readonly x: number; readonly y: number };
  }

  let sample: Sample | undefined;
  for (let tile = 0; tile < state.tileOwner.length && sample === undefined; tile += 1) {
    if (state.tileOwner[tile] !== owner) continue;
    if (state.explored[owner]?.[tile] !== true) continue;
    if (busy.has(tile)) continue;
    const x = tileX(state, tile);
    const y = tileY(state, tile);
    // Through the app's own projection, and required to be fully inside the canvas: a sample that
    // landed outside the viewport would read whatever the panel behind it painted.
    const at = tileToScreen(camera, x, y);
    if (at.x < 0 || at.y < 0 || at.x + size > box.width || at.y + size > box.height) continue;

    const edges: readonly { readonly edge: string; readonly point: { x: number; y: number } }[] = [
      ...(ownerOn(x - 1, y) !== owner
        ? [{ edge: 'left', point: { x: at.x + band / 2, y: at.y + size / 2 } }]
        : []),
      ...(ownerOn(x + 1, y) !== owner
        ? [{ edge: 'right', point: { x: at.x + size - band / 2, y: at.y + size / 2 } }]
        : []),
      ...(ownerOn(x, y - 1) !== owner
        ? [{ edge: 'up', point: { x: at.x + size / 2, y: at.y + band / 2 } }]
        : []),
      ...(ownerOn(x, y + 1) !== owner
        ? [{ edge: 'down', point: { x: at.x + size / 2, y: at.y + size - band / 2 } }]
        : []),
    ];
    const first = edges[0];
    if (first === undefined) continue;
    sample = {
      tile,
      edge: first.edge,
      point: first.point,
      centre: { x: at.x + size / 2, y: at.y + size / 2 },
    };
  }

  expect(
    sample,
    'no owned tile with a foreign edge was fully on screen, so nothing about the border’s colour ' +
      'could be sampled',
  ).toBeDefined();
  if (sample === undefined) return;

  const edgeColour = await sampleCanvasPixel(page, sample.point);
  expect(
    edgeColour.a,
    `nothing was painted at the ${sample.edge} edge of tile ${String(sample.tile)}`,
  ).toBe(255);
  expect(
    colourDistance(edgeColour, expected),
    `the ${sample.edge} border of tile ${String(sample.tile)} sampled ` +
      `${describeColour(edgeColour)} and the state gives player ${String(owner)} the colour ` +
      `${player.color} — the tint never reached the canvas`,
  ).toBeLessThanOrEqual(8);

  // …and the band is a BORDER, not a wash: the tile's centre is still its terrain, which is what
  // keeps the terrain pixel tests — and a player's reading of the map — meaningful.
  const centreColour = await sampleCanvasPixel(page, sample.centre);
  expect(
    colourDistance(centreColour, expected),
    `the owner's colour also covers the centre of tile ${String(sample.tile)} ` +
      `(${describeColour(centreColour)}), so the border is a fill of the whole tile rather than a ` +
      `tint along its edges`,
  ).toBeGreaterThan(24);
});

/* ------------------------------------------------------------------ *
 * 2. THE CITY SCREEN: CULTURE AND HAPPINESS
 * ------------------------------------------------------------------ */

test('M9 city screen: culture and happiness are the ENGINE’s own readouts, not a recomputation', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  const city = await foundCity(page);
  const state = await readState(page);
  const owner = humanPlayerId(state);

  const dialog = await openCity(page, state, await cameraOf(page), city);
  await expect(dialog).toBeVisible();

  // The engine's own board for this seed and this script. The hash is compared FIRST, so every
  // figure read off it is a figure about the game on screen.
  const engineState = await replayHeadless(page, 0);
  expect(
    await stateHash(page),
    'the browser is not the game the engine builds for this seed, so the figures below would be ' +
      'about a different board',
  ).toBe(hashOf(engineState));

  const engineCity = engineState.cities.find((candidate) => candidate.id === city.id);
  expect(engineCity, 'the headless replay has no city with the browser’s id').toBeDefined();
  if (engineCity === undefined) return;

  const mood = happinessOf(engineState, RULESET, engineCity);
  expect(
    await cityFact(dialog, 'Happiness'),
    'the happiness line is not the engine’s own counts',
  ).toBe(
    `${String(mood.happy)} happy, ${String(mood.content)} content, ${String(mood.unhappy)} unhappy`,
  );

  const culture = await cityFact(dialog, 'Culture');
  expect(culture, 'the culture line does not carry the city’s own accumulated figure').toContain(
    String(engineCity.culture),
  );
  expect(culture, 'the culture line does not carry the DERIVED player total').toContain(
    String(playerCulture(engineState, owner)),
  );

  // Disorder is the engine's verdict — `isDisordered` is `happinessOf(...).disordered` asked by id
  // — so the line on screen and the flag the production, growth and money loops acted on are one.
  expect(await cityFact(dialog, 'Disorder')).toBe(
    mood.disordered
      ? 'civil disorder — no shields, no beakers, no gold and no growth this turn'
      : 'in good order',
  );
});

/* ------------------------------------------------------------------ *
 * 3. THE GOVERNMENT SELECTOR
 * ------------------------------------------------------------------ */

test('M9 government: the menu is the engine’s catalog, and the refusal a player reads is the engine’s own', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  expect(
    await recordDispatches(page),
    'the seam refused to be instrumented, so "the control dispatched SetGovernment" could not be seen',
  ).toBe(true);
  await closeDialogs(page);

  const menu = governmentMenu(page);
  const button = governmentButton(page);
  const notice = governmentVerdict(page);
  await expect(menu).toBeVisible();
  await expect(notice).toBeVisible();

  // The menu IS the catalog: every row the ruleset declares, in catalog order, spelled the engine's
  // way. A UI that invented a row or dropped one fails here.
  const catalog = governmentCatalog(RULESET);
  expect(catalog.length, 'the shipped catalog ships no governments at all').toBeGreaterThan(0);
  expect(
    await menu
      .locator('option')
      .evaluateAll((options) =>
        options.map((option) => (option instanceof HTMLOptionElement ? option.value : '')),
      ),
  ).toEqual(catalog.map((row) => row.id));
  expect(await menu.locator('option').allInnerTexts()).toEqual(catalog.map((row) => row.name));

  // It opens showing the state's OWN government, with the engine's verdict on it.
  const state = await readState(page);
  const owner = humanPlayerId(state);
  const engineGovernment =
    state.players.find((candidate) => candidate.id === owner)?.government ?? '';
  expect(engineGovernment, 'the state carries no government for the acting seat').not.toBe('');
  await expect(menu).toHaveValue(engineGovernment);
  await expect(button).toBeEnabled();
  await expect(notice).toContainText('the engine accepts');

  // The hash of the position BEFORE any refusal, so the two refusals below are checked against
  // "nothing moved" rather than against a claim about what they did.
  const hashBefore = await stateHash(page);

  // A gated row: the shipped catalog puts a government behind a technology, so selecting it shows
  // the ENGINE's `government-tech-required` refusal and closes the control. This is the keystone
  // property at this panel, with the sentence a player reads coming from `planSetGovernment` —
  // the evaluator `applyCommand` itself refuses with — rather than from a rule restated in the UI.
  const gated = catalog.find((row) => row.requiresTech !== undefined);
  expect(
    gated,
    'no shipped government is behind a technology, so this case is vacuous',
  ).toBeDefined();
  if (gated === undefined) return;
  await menu.selectOption(gated.id);
  await expect(notice).toContainText('government-tech-required');
  await expect(notice).toContainText(gated.name);
  await expect(button).toBeDisabled();

  // The refusal is the ENGINE's, not the panel's: the same command sent straight through the seam
  // is refused as well, and leaves the state alone.
  expect(
    await dispatch(page, { type: 'SetGovernment', government: gated.id }),
    'the engine accepted a government the panel refused, so the panel is the one deciding',
  ).toBe('refused');

  // An id no row defines is refused by the engine in its own words too. The MENU cannot offer it
  // (the menu is the catalog), which is exactly why `governmentVerdict` is a function of a
  // government ID rather than of the menu: a stale save or a hand-built state can name one, and
  // `packages/web/test/panels/government.test.ts` pins the panel's rendering of that refusal.
  expect(
    await dispatch(page, { type: 'SetGovernment', government: 'senate' }),
    'the engine accepted a government id no row defines',
  ).toBe('refused');
  expect(await stateHash(page), 'a refused SetGovernment changed the state').toBe(hashBefore);

  // …and back to the row the engine accepts, dispatched by the control itself.
  await menu.selectOption(engineGovernment);
  await expect(button).toBeEnabled();
  await expect(notice).toContainText('the engine accepts');
  await clearDispatchLog(page);
  await button.click();
  const dispatched = await dispatchLog(page);
  expect(dispatched.length, 'the `Set government` control dispatched nothing').toBeGreaterThan(0);
  expect(
    dispatched.every(
      (entry) =>
        typeof entry.action === 'object' &&
        entry.action !== null &&
        'type' in entry.action &&
        entry.action.type === 'SetGovernment',
    ),
    `the control dispatched something other than SetGovernment: ${JSON.stringify(
      dispatched.map((entry) => entry.action),
    )}`,
  ).toBe(true);
  expect(
    dispatched.every((entry) => entry.result === 'ok'),
    // The panel's own verdict is in the message on purpose: when this failed (M9's `SetGovernment`
    // was missing from the seam's action reader, so the click never reached the engine) the panel
    // said "the engine accepts Despotism" while the click came back refused, and that pair is the
    // whole diagnosis.
    `the engine refused the government the control applied: ${JSON.stringify(
      dispatched.map((entry) => ({ action: entry.action, result: entry.result })),
    )} — the panel says: ${await notice.innerText()}`,
  ).toBe(true);

  // Every OTHER row of the shipped catalog is a command this seat may not issue yet, so the engine
  // refuses each of them — the other half of "the panel only enables what the engine accepts".
  for (const row of catalog) {
    if (row.id === engineGovernment) continue;
    expect(
      await dispatch(page, { type: 'SetGovernment', government: row.id }),
      `the engine accepted ${row.id}, which this seat should not be able to adopt yet`,
    ).toBe('refused');
  }
});

/* ------------------------------------------------------------------ *
 * 4. THE SCORE COLUMN
 * ------------------------------------------------------------------ */

test('M10 scoreboard: the Score column is the engine’s own scoreTable, player for player', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  await closeDialogs(page);

  const state = await readState(page);
  const table = scoreboard(page);
  await expect(table).toBeVisible();
  expect(
    await table.getByRole('columnheader', { name: 'Score' }).count(),
    'the scoreboard has no Score columnheader',
  ).toBe(1);

  const engineState = await replayHeadless(page, 0);
  expect(await stateHash(page), 'the browser is not the engine’s own game for this seed').toBe(
    hashOf(engineState),
  );
  const scores = new Map<number, number>(
    scoreTable(engineState, RULESET).map((row) => [Number(row.playerId), row.score]),
  );

  const body = table.locator('tbody tr');
  const rowCount = await body.count();
  expect(rowCount, 'the scoreboard has no rows').toBe(state.players.length);
  const seen = new Set<string>();
  for (let index = 0; index < rowCount; index += 1) {
    // Cells, not the row's flattened text: `allInnerTexts` on a `<tr>` returns one tab-joined
    // string, which would turn "the last cell is the score" into an assertion about a split.
    const cells = (await body.nth(index).locator('td, th').allInnerTexts()).map((cell) =>
      cell.trim(),
    );
    const name = cells[0] ?? '';
    seen.add(name);
    const player = state.players.find((candidate) => candidate.name === name);
    expect(player, `the scoreboard has a row for ${name}, who is not in the state`).toBeDefined();
    if (player === undefined) continue;
    const score = scores.get(player.id);
    expect(score, `the engine's score table has no row for ${player.name}`).toBeDefined();
    expect(
      cells.at(-1),
      `the Score cell for ${player.name} is not the engine's own score (${String(score)})`,
    ).toBe(String(score));
  }
  expect([...seen].sort(), 'the scoreboard does not carry a row for every player').toEqual(
    state.players.map((player) => player.name).sort(),
  );

  // Not vacuous: founding a city moves the figure off zero, so the column is not a constant.
  expect(
    [...scores.values()].some((score) => score > 0),
    'every score is zero, so “the column shows the engine’s score” would hold for a column of zeros',
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 5. THE VICTORY / DEFEAT SCREEN
 * ------------------------------------------------------------------ */

test('M10 victory screen: a real game played to its end shows the derived outcome and closes the commands', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openApp(page);
  await seedApp(page, SEED);
  const owner = humanPlayerId(await readState(page));
  await foundCity(page);
  await closeDialogs(page);

  // The screen is DERIVED, so while the game runs there is no outcome, no dialog and no control
  // that could show one.
  await expect(gameOverDialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show outcome' })).toBeHidden();

  // Play to the end. The engine's score condition fires at `scoreHorizon(RULESET)`, so the game
  // ends on one of these turns. Most go through the frozen seam (the same applier every control
  // uses, one round trip each); the rest go through the app's OWN `End turn` control, so the ending
  // is reached by a control a player has. The loop stops when the app closes that control — the
  // UI's own report that the engine has finished the game — rather than at a turn this test guessed.
  const horizon = scoreHorizon(RULESET);
  expect(horizon, 'the shipped catalog declares no score horizon').toBeGreaterThan(2);
  const fast = Math.max(0, horizon - 3);
  for (let turn = 0; turn < fast; turn += 1) {
    expect(await dispatch(page, { type: 'EndTurn' }), `seam end-turn ${String(turn + 1)}`).toBe(
      'ok',
    );
  }
  let issued = fast;
  while (!(await endTurnButton(page).isDisabled())) {
    await endTurnButton(page).click();
    issued += 1;
    if (issued > horizon + 50) {
      throw new Error(
        `the End turn control never closed: ${String(issued)} turns were ended and the game has not ` +
          `finished`,
      );
    }
  }

  // The screen the outcome derives into: visible, and naming the condition, the turn and the winner
  // the ENGINE decided. The expected outcome is the same engine's answer for the same script.
  const dialog = gameOverDialog(page);
  await expect(dialog).toBeVisible();
  // `textContent`, not `innerText`: the shipped `[data-panel] h2` rule uppercases every panel
  // heading, and `innerText` would answer with the stylesheet's rendering. What is being checked is
  // which of the engine's kinds is named, not the case it is displayed in.
  const headline = ((await dialog.locator('h2').textContent()) ?? '').trim();
  const detail = await dialog.locator('p').innerText();

  const replayed = await replayHeadless(page, issued);
  expect(
    await stateHash(page),
    `the browser's game and the engine's replay diverged after ${String(issued)} end-turn commands`,
  ).toBe(hashOf(replayed));
  // The game ended because it was PLAYED OUT, not because some other condition happened to fire
  // early: if a conquest or a cultural victory had ended it first, this test would be asserting the
  // screen for an outcome the milestone's ending was not the one driving.
  expect(
    replayed.turn,
    'the game ended before the score horizon, so this test did not play the game to its end',
  ).toBeGreaterThanOrEqual(horizon);

  const outcome = outcomeFor(replayed, RULESET, owner);
  expect(outcome, 'the engine reports no outcome for a game the UI has closed').toBeDefined();
  if (outcome === undefined) return;

  const headings: Readonly<Record<string, string>> = {
    victory: 'victory',
    defeat: 'defeat',
    draw: 'draw',
  };
  expect(
    headline.toLowerCase(),
    'the screen does not name the kind of outcome the engine reported',
  ).toBe(headings[outcome.kind]);
  expect(detail, 'the screen does not name the engine’s condition').toContain(
    `"${outcome.condition}"`,
  );
  expect(detail, 'the screen does not name the engine’s turn').toContain(
    `turn ${String(outcome.turn)}`,
  );
  if (outcome.winner === null) {
    expect(detail, 'a draw must say nobody won rather than print a missing name').toContain(
      'nobody won',
    );
  } else {
    const winner = replayed.players.find((candidate) => candidate.id === outcome.winner);
    expect(winner, 'the engine named a winner the state does not contain').toBeDefined();
    expect(detail, `the screen does not name ${winner?.name ?? 'the winner'}`).toContain(
      winner?.name ?? '',
    );
  }

  // **No control keeps offering a command the engine would refuse.** The engine answers `game-over`
  // to every command but `EndTurn` on a finished game, so the controls that dispatch one are closed.
  await expect(endTurnButton(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Set rates' })).toBeDisabled();
  await expect(governmentButton(page)).toBeDisabled();
  expect(
    await dispatch(page, { type: 'SetRates', rates: { tax: 1, science: 1, luxury: 0 } }),
    'the engine accepted a command on a finished game, so the closed controls are not the whole story',
  ).toBe('refused');

  // A panel that REBUILDS its controls on open is closed too: the tech tree is the one with dozens
  // of rows, and every row must say no.
  const tech = await openPanel(page, /^Technology$/);
  const rows = tech.getByRole('button', { name: /\(/ });
  const rowCount = await rows.count();
  expect(rowCount, 'the tech tree shows no tech rows to check').toBeGreaterThan(0);
  const stillOffered: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isEnabled())) continue;
    stillOffered.push((await row.innerText()).trim());
  }
  expect(
    stillOffered,
    'the tech tree still offers research on a game the engine has ended, so those rows would ' +
      'dispatch a command the applier refuses with `game-over`',
  ).toEqual([]);
  await closeDialogs(page);

  // Dismissing the screen is not dismissing the game, and looking at the final position is not a
  // command. The tech panel above was closed with `closeDialogs`, and the outcome screen went with
  // it — `Close outcome` is a Close control like any other — so this block re-opens it, closes it
  // again, and then forces a panel refresh (a REFUSED command re-renders every panel from the state
  // that did not change) to check the screen stays closed: a panel that re-asserted itself on every
  // redraw would be a modal a player cannot get out of. `shownFor` in `victory.ts` is what makes it
  // once-per-outcome rather than once-per-frame.
  await expect(dialog).toBeHidden();
  const opener = page.getByRole('button', { name: 'Show outcome' });
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText(headline);

  await dialog.getByRole('button', { name: 'Close outcome' }).click();
  await expect(dialog).toBeHidden();
  expect(
    await dispatch(page, { type: 'SetResearch', tech: 'bronze-working' }),
    'the engine accepted a command on a finished game while the screen was closed',
  ).toBe('refused');
  await expect(dialog).toBeHidden();
  await expect(gameOverDialog(page)).toBeHidden();
  await expect(opener).toBeVisible();
});
