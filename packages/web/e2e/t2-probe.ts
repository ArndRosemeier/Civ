/**
 * T2's independent probe — a scratch instrument, not part of the suite.
 *
 * Its name does not match Playwright's `testMatch`, so `npx playwright test` never collects it.
 * It is driven with `npx tsx e2e/t2-probe.ts` from `packages/web`, against the app the config's
 * own webServer serves on 127.0.0.1:4174.
 *
 * ## Why it exists rather than a second spec file
 *
 * The conformance gate (`s2-a1-conformance.spec.ts`) was written by an earlier verification
 * pass, so its assertions are not T2's. This probe measures the same claims its own way — and
 * adds three the gate does not make:
 *
 * 1. **The rival's commands are compared, one turn at a time, against `@civts/sim`'s own
 *    `SMART_POLICY`**, run on the very state the app planned against. The gate asks whether
 *    *some* accepted command named a rival unit; this asks whether the browser's opponent is the
 *    shipped policy or a second decision-maker wearing its name.
 * 2. **The world RNG is compared against a headless game no policy ever touched**, not only
 *    against the app's own AI-off arm — so "the policy does not draw from `state.rng`" is
 *    measured against the world's stream rather than against a second run of the same code.
 * 3. **The browser-vs-headless hash equality is measured WITH the opponent playing**, not only
 *    for the human-only reference the gate uses.
 *
 * Exit code 0 iff every check passed.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  applyCommand,
  asPlayerId,
  civPlayers,
  DEFAULT_SETTINGS,
  deserialize,
  newGame,
  parseSettings,
  type GameState,
  type PlayerId,
  type SaveCodec,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';
import { DO_NOTHING_POLICY, SMART_POLICY, policyRngFor, type Policy } from '@civts/sim';

import {
  clearDispatchLog,
  dispatchLog,
  endTurnButton,
  foundCity,
  humanPlayerId,
  readSettings,
  recordDispatches,
  seedApp,
  stateHash,
} from './helpers.js';

const ORIGIN = 'http://127.0.0.1:4174';
const SAVE_KEY = 'civts.save.v1';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET = validated.value;

/** The engine's own codec, as `packages/web/src/panels/save.ts` builds it. */
const CODEC: SaveCodec = { hash: hashValue, invariants: [] };

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};
const note = (text: string): void => {
  console.log(`      · ${text}`);
};

/* ------------------------------------------------------------------ *
 * Driving the app
 * ------------------------------------------------------------------ */

const openApp = async (page: Page): Promise<void> => {
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__CIVTS__?.ready === true, undefined, {
    timeout: 60_000,
  });
};

/**
 * The authoritative `GameState`, taken through the app's OWN save path.
 *
 * `window.__CIVTS__.state()` crosses Playwright's serializer, which is not a faithful transport
 * for the state's typed arrays; the save payload is JSON the engine itself wrote and can read
 * back, so `deserialize` here returns the state the app is really playing. Clicking `Save game`
 * dispatches nothing and changes nothing.
 */
const authoritativeState = async (page: Page): Promise<GameState> => {
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  const text = await page.evaluate((key: string) => window.localStorage.getItem(key), SAVE_KEY);
  if (text === null) throw new Error('the app wrote no save');
  const loaded = deserialize(text, CODEC);
  if (!loaded.ok) throw new Error(`the app's own save does not load: ${loaded.error.kind}`);
  return loaded.value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const actionTypeOf = (action: unknown): string => {
  if (!isRecord(action)) return 'not-an-object';
  const type = action['type'];
  return typeof type === 'string' ? type : 'no-type';
};

/** Key-order independent, the way the project's own comparisons are. */
const canonical = (value: unknown): string => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
};

const rivalOf = (state: GameState): PlayerId => {
  const human = civPlayers(state)[0];
  if (human === undefined) throw new Error('the game has no civilization');
  const rival = civPlayers(state).find((player) => player.id !== human.id);
  if (rival === undefined) throw new Error('the game has no rival civilization');
  return asPlayerId(rival.id);
};

/** One seat, reduced to the facts "did this seat do anything?" needs. */
const seatOf = (state: GameState, owner: number): string => {
  const units = state.units.filter((unit) => unit.owner === owner);
  const player = state.players.find((candidate) => candidate.id === owner);
  return JSON.stringify({
    cities: state.cities.filter((city) => city.owner === owner).length,
    units: units.length,
    tiles: units
      .map((unit) => `${String(unit.id)}@${String(unit.tile)}`)
      .sort()
      .join(','),
    techs: player?.techs.length ?? -1,
    treasury: player?.treasury ?? -1,
    owned: [...state.tileOwner].filter((value) => value === owner).length,
  });
};

const startOf = (settings: Settings): GameState => {
  const started = newGame(settings.seed, settings, RULESET);
  if (!started.ok) throw new Error(`newGame refused: ${started.error.kind}`);
  return started.value;
};

/* ------------------------------------------------------------------ *
 * The headless references
 * ------------------------------------------------------------------ */

/**
 * The browser's own turn pipeline, headlessly: the human's scripted commands, then every rival
 * seat polled through `policy` with **its own stream from `policyRngFor`**, then the human's
 * `EndTurn` — which is what advances the world in the browser too.
 */
const headlessGame = (settings: Settings, turns: number, policy: Policy): GameState => {
  let state: GameState = startOf(settings);
  const human = civPlayers(state)[0];
  if (human === undefined) throw new Error('the headless game has no civilization');

  for (let turn = 0; turn < turns; turn += 1) {
    if (turn === 0) {
      const settler = state.units.find((unit) => unit.owner === human.id);
      if (settler !== undefined) {
        const founded = applyCommand(
          state,
          asPlayerId(human.id),
          { type: 'FoundCity', unitId: settler.id },
          RULESET,
        );
        if (!founded.ok) throw new Error('the scripted FoundCity was refused');
        state = founded.value.state;
      }
    }
    for (const player of civPlayers(state)) {
      if (player.id === human.id) continue;
      const proposed = policy.chooseCommands({
        state,
        playerId: player.id,
        ruleset: RULESET,
        rng: policyRngFor(settings.seed, player.id, state.turn),
      });
      for (const command of proposed) {
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, RULESET);
        if (outcome.ok) state = outcome.value.state;
      }
    }
    const ended = applyCommand(state, asPlayerId(human.id), { type: 'EndTurn' }, RULESET);
    if (!ended.ok) throw new Error(`the scripted EndTurn was refused: ${ended.error.kind}`);
    state = ended.value.state;
  }
  return state;
};

/** The world's stream after the same human script with NO policy playing any seat. */
const rngAfterHumanOnly = (settings: Settings, turns: number): string =>
  JSON.stringify(headlessGame(settings, turns, DO_NOTHING_POLICY).rng);

const fixture = (patch: Record<string, unknown> & { readonly seed: number }): Settings => {
  const parsed = parseSettings({ ...DEFAULT_SETTINGS, ...patch });
  if (!parsed.ok) throw new Error(`the fixture does not parse: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
};

/* ------------------------------------------------------------------ *
 * The browser game, turn by turn, with the shipped policy as the oracle
 * ------------------------------------------------------------------ */

interface TurnRecord {
  readonly turn: number;
  readonly expected: readonly string[];
  readonly issued: readonly string[];
  readonly agreed: boolean;
}

const playWithOracle = async (
  page: Page,
  settings: Settings,
  turns: number,
): Promise<{
  readonly records: readonly TurnRecord[];
  readonly state: GameState;
  readonly clicks: number;
}> => {
  await seedApp(page, settings.seed, settings);
  await recordDispatches(page);
  await foundCity(page);
  const rival = rivalOf(await authoritativeState(page));
  const records: TurnRecord[] = [];

  let clicks = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const before = await authoritativeState(page);
    const proposed = SMART_POLICY.chooseCommands({
      state: before,
      playerId: rival,
      ruleset: RULESET,
      rng: policyRngFor(settings.seed, rival, before.turn),
    });
    const expected = proposed.filter((command) => command.type !== 'EndTurn').map(canonical);

    await clearDispatchLog(page);
    const button = endTurnButton(page);
    if (await button.isDisabled()) break;
    await button.click();
    clicks += 1;

    const log = await dispatchLog(page);
    const issued = log
      .filter((entry) => entry.result === 'ok' && actionTypeOf(entry.action) !== 'EndTurn')
      .map((entry) => canonical(entry.action));
    records.push({
      turn: before.turn,
      expected,
      issued,
      agreed:
        expected.length === issued.length &&
        expected.every((command, at) => command === issued[at]),
    });
  }
  return { records, state: await authoritativeState(page), clicks };
};

const playTurns = async (page: Page, turns: number): Promise<number> => {
  let clicks = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const button = endTurnButton(page);
    if (await button.isDisabled()) break;
    await button.click();
    clicks += 1;
  }
  return clicks;
};

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

const controlNames = async (page: Page): Promise<readonly string[]> => {
  const names: string[] = [];
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (await button.isVisible()) names.push((await button.innerText()).trim());
  }
  return names;
};

const section = (title: string): void => {
  console.log(`\n--- ${title} ---`);
};

const main = async (): Promise<void> => {
  const browser: Browser = await chromium.launch();

  section('the opponent is the SHIPPED policy, and it acts');
  {
    const context: BrowserContext = await browser.newContext();
    const page = await context.newPage();
    await openApp(page);

    const settings = fixture({ seed: 11, mapSize: 'duel', civCount: 2 });
    const appSettings = parseSettings(await readSettings(page));
    note(`clean app settings parse=${String(appSettings.ok)}`);
    const start = startOf(settings);
    const played = await playWithOracle(page, settings, 30);
    const rival = rivalOf(played.state);
    const startSeat = seatOf(start, rival);
    const endSeat = seatOf(played.state, rival);
    const totalExpected = played.records.reduce((sum, r) => sum + r.expected.length, 0);
    const totalIssued = played.records.reduce((sum, r) => sum + r.issued.length, 0);
    const agreed = played.records.filter((record) => record.agreed).length;
    const firstDisagreement = played.records.find((record) => !record.agreed);

    check(
      'A1(a) the rival acts, with commands the engine accepted',
      endSeat !== startSeat && totalIssued > 0,
      `rival start=${startSeat} end=${endSeat} acceptedRivalCommands=${String(totalIssued)} ` +
        `turns=${String(played.clicks)}`,
    );
    check(
      'A2(a) the browser opponent IS `@civts/sim`’s SMART_POLICY',
      agreed === played.records.length && totalExpected === totalIssued,
      `${String(agreed)}/${String(played.records.length)} turns agree with SMART_POLICY ` +
        `(expected=${String(totalExpected)} issued=${String(totalIssued)})` +
        (firstDisagreement === undefined
          ? ''
          : ` — first disagreement at turn ${String(firstDisagreement.turn)}:` +
            ` expected=${JSON.stringify(firstDisagreement.expected)}` +
            ` issued=${JSON.stringify(firstDisagreement.issued)}`),
    );
    note(`final turn ${String(played.state.turn)} hash ${hashValue(played.state)}`);

    /* ---- the world RNG, measured against a game no policy touched ---------- */
    const worldRng = JSON.stringify(played.state.rng);
    const humanOnlyRng = rngAfterHumanOnly(settings, played.clicks);
    check(
      'A2(b) the policy does not draw from `state.rng`',
      worldRng === humanOnlyRng,
      `browser-with-AI ${worldRng} vs headless-human-only ${humanOnlyRng} — same turn ` +
        String(played.state.turn),
    );

    /* ---- browser == headless, WITH the opponent playing -------------------- */
    const headless = headlessGame(settings, played.clicks, SMART_POLICY);
    check(
      'A2(c) the UI adds no rules, with the opponent on',
      hashValue(headless) === hashValue(played.state),
      `browser=${hashValue(played.state)} headless(SMART_POLICY)=${hashValue(headless)} ` +
        `turns=${String(played.clicks)}`,
    );

    /* ---- determinism across two browser contexts -------------------------- */
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await openApp(secondPage);
    await seedApp(secondPage, settings.seed, settings);
    await foundCity(secondPage);
    await playTurns(secondPage, played.clicks);
    const secondHash = await stateHash(secondPage);
    check(
      'A2(d) the same seed and script give the same game in two contexts',
      secondHash === hashValue(played.state),
      `context1=${hashValue(played.state)} context2=${secondHash} headless=${hashValue(headless)}`,
    );
    await second.close();
    await context.close();
  }

  section('`ai.opponent` is a real, surviving engine field');
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openApp(page);
    const raw = await page.evaluate(() => {
      const api = window.__CIVTS__;
      if (api === undefined) throw new Error('no seam');
      api.seed(3, { ai: { opponent: 'off' } });
      return { settings: api.settings(), state: api.state() };
    });
    const parsed = parseSettings(raw.settings);
    const stateSeed = isRecord(raw.state) ? raw.state['seed'] : undefined;
    const aiText = parsed.ok ? JSON.stringify(parsed.value.ai) : JSON.stringify(parsed.error);
    check(
      'A1(e) `ai.opponent` is validated and not stripped',
      parsed.ok &&
        JSON.stringify(parsed.value.ai) ===
          JSON.stringify({ aggression: 0.5, expandFast: false, opponent: 'off' }) &&
        stateSeed === 3,
      `parseSettings(settings())=${String(parsed.ok)} ai=${aiText} stateSeed=${String(stateSeed)}`,
    );
    await context.close();
  }

  section('the engine refuses invalid settings');
  {
    const refusals: string[] = [];
    for (const [what, patch] of [
      ['unknown map size', { mapSize: 'gigantic' }],
      ['one civilization', { civCount: 1 }],
      ['99 civilizations', { civCount: 99 }],
      ['fractional seed', { seed: 1.5 }],
      ['unknown opponent', { ai: { aggression: 0.5, expandFast: false, opponent: 'maybe' } }],
    ] as const) {
      const parsed = parseSettings({ ...DEFAULT_SETTINGS, ...patch });
      refusals.push(`${what}=${parsed.ok ? 'ACCEPTED' : 'refused'}`);
    }
    check(
      'A1(f) the engine refuses invalid settings',
      refusals.every((line) => line.endsWith('refused')),
      refusals.join(' | '),
    );
  }

  section('a clean page offers a game-setup control');
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openApp(page);
    const names = await controlNames(page);
    const setupish = names.filter((name) => /new game|settings|setup|scenario/i.test(name));
    check(
      'A1(d) a clean page offers a game-setup control',
      setupish.length > 0,
      `controls=${names.join(' | ')} — setup-like: ${setupish.join(', ') || 'NONE'}`,
    );
    await context.close();
  }

  section('a real game to an end, against a live opponent');
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
    await openApp(page);

    const settings = fixture({ seed: 11, mapSize: 'duel', civCount: 2 });
    const start = startOf(settings);
    await seedApp(page, settings.seed, settings);
    const human = humanPlayerId(await seedApp(page, settings.seed, settings));
    const rival = rivalOf(start);
    const startRival = seatOf(start, rival);
    const startHuman = seatOf(start, human);
    await foundCity(page);
    const clicks = await playTurns(page, 210);
    const end = await authoritativeState(page);
    const outcome = page.getByRole('dialog', { name: 'Game over' });
    const visible = await outcome.isVisible();
    const headline = visible ? ((await outcome.locator('h2').textContent()) ?? '').trim() : 'none';
    const detail = visible ? await outcome.locator('p').innerText() : 'none';
    const endRival = seatOf(end, rival);
    check(
      'A1(g) a real game reaches a victory/defeat screen against a live rival',
      visible && endRival !== startRival,
      `turns=${String(end.turn)} clicks=${String(clicks)} screen=${String(visible)} ` +
        `headline="${headline}" detail="${detail}" ` +
        `human=${startHuman}->${seatOf(end, human)} rival=${startRival}->${endRival} ` +
        `hash=${hashValue(end)}`,
    );
    await context.close();
  }

  await browser.close();

  const failed = checks.filter((entry) => !entry.ok);
  console.log(
    `\n==== ${String(checks.length - failed.length)}/${String(checks.length)} checks passed ====`,
  );
  for (const entry of failed) console.log(`FAILED: ${entry.name}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();
