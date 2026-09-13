/**
 * The scoreboard: `table` named `Scoreboard`, one row per player **and the score column M8 could
 * not have**.
 * See docs/INTERFACES.md, M8 ("The accessibility contract") and M9+M10 ("Victory and score").
 *
 * ## The score column arrived with the scoring rule, and reads it
 *
 * M8 asked for a scoreboard and this project had no scoring rule: nothing in `@civts/core` ranked
 * players, and inventing a points formula in the UI would have been a **game rule living in the
 * presentation layer** — the exact thing this package's hard rule forbids — and a rule no test, no
 * AI and no future milestone could see or agree with. So the column was left out and the reason was
 * written down here.
 *
 * M10 landed `score.ts`: five weighted terms over population, cities, techs, culture and wonders,
 * with the weights in the catalog. `scoreTable(state, ruleset)` is the **one** scoring function in
 * the engine, and it is also what the score victory condition reads through `highestScore` — so the
 * figure in this table and the figure that decides the game cannot disagree, which is the same
 * "one computation, two readers" discipline `cityYields` and `happinessOf` follow. The UI computes
 * no weighted sum of its own; it prints the engine's number.
 *
 * ## Everything else is still a direct read
 *
 * The remaining columns report what the engine *does* know, as counts and totals read straight off
 * the state: cities, units, population, treasury, techs, beakers. Every figure is a direct read (a
 * `length`, a `sum`, a stored field) with no weighting, no rounding and no formula.
 */

import {
  civPlayers,
  scoreTable,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import type { PanelContext } from './index.js';

/** One row of the scoreboard. */
export interface ScoreRow {
  readonly id: PlayerId;
  readonly player: string;
  readonly kind: 'civ' | 'barbarian';
  readonly cities: number;
  readonly units: number;
  readonly population: number;
  readonly treasury: number;
  readonly techs: number;
  readonly beakers: number;
  /** The engine's own score — `scoreTable`, the same number the score victory reads. */
  readonly score: number;
}

/**
 * Every player in `state.players` order (which is player-id order), barbarians included.
 *
 * The barbarian row is shown rather than hidden for the same reason the state gives it a
 * `treasury` and an `explored` row: one shape for every player, and a scoreboard that
 * silently omitted a player with units on the map would be a table that disagrees with the
 * world it describes.
 *
 * `scoreTable` answers one row per player in the same id order, so the lookup below is total for
 * every state this function is handed; the `?? 0` is the reading a value the table did not carry
 * gets — the same total reading `score.ts` gives a missing field, rather than a screen that
 * throws on a hand-built state.
 */
export const scoreboardRows = (state: GameState, ruleset: RulesetView): readonly ScoreRow[] => {
  const scores = new Map<number, number>(
    scoreTable(state, ruleset).map((row) => [Number(row.playerId), row.score]),
  );
  return state.players.map((player) => {
    const cities = state.cities.filter((city) => city.owner === player.id);
    return {
      id: player.id,
      player: player.name,
      kind: player.kind,
      cities: cities.length,
      units: state.units.filter((unit) => unit.owner === player.id).length,
      population: cities.reduce((total, city) => total + city.population, 0),
      treasury: player.treasury,
      techs: player.techs.length,
      beakers: player.beakers,
      score: scores.get(Number(player.id)) ?? 0,
    };
  });
};

/** The civilizations only — the rows a player can actually be on the scoreboard with. */
export const civilizationRows = (state: GameState, ruleset: RulesetView): readonly ScoreRow[] => {
  const civs = new Set<number>(civPlayers(state).map((player) => Number(player.id)));
  return scoreboardRows(state, ruleset).filter((row) => civs.has(Number(row.id)));
};

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const COLUMNS = [
  'Player',
  'Cities',
  'Units',
  'Population',
  'Treasury',
  'Techs',
  'Beakers',
  'Score',
] as const;

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface ScoreboardHandle {
  readonly element: HTMLElement;
  refresh(): void;
}

/**
 * Mount the scoreboard into `parent`. The table's accessible name comes from its `<caption>`
 * (`Scoreboard`) rather than from an `aria-label`, which is the standard way a table is named
 * and what a screen reader announces first.
 */
export const mountScoreboard = (parent: HTMLElement, ctx: PanelContext): ScoreboardHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'section');
  element.dataset['panel'] = 'scoreboard';

  const table = el(doc, 'table');
  table.dataset['role'] = 'scoreboard';
  table.append(el(doc, 'caption', 'Scoreboard'));
  const head = el(doc, 'thead');
  const headRow = el(doc, 'tr');
  for (const column of COLUMNS) {
    const cell = el(doc, 'th', column);
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  const body = el(doc, 'tbody');
  table.append(head, body);

  element.append(el(doc, 'h2', 'Scoreboard'), table);
  parent.append(element);

  const refresh = (): void => {
    const state = ctx.api.state();
    body.replaceChildren();
    for (const row of scoreboardRows(state, ctx.api.ruleset)) {
      const tr = el(doc, 'tr');
      const values: readonly string[] = [
        row.player,
        String(row.cities),
        String(row.units),
        String(row.population),
        String(row.treasury),
        String(row.techs),
        String(row.beakers),
        // The engine's own score — `scoreTable`, never a sum computed here. `String` is a
        // presentation of the number, not a second derivation of it.
        String(row.score),
      ];
      for (const value of values) tr.append(el(doc, 'td', value));
      body.append(tr);
    }
  };

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, refresh };
};
