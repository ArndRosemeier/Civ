/**
 * The scoreboard: `table` named `Scoreboard`, one row per player.
 * See docs/INTERFACES.md, M8 ("The accessibility contract").
 *
 * ## There is no score in the engine, so there is no score column here
 *
 * M8 asks for a scoreboard and this project has no scoring rule: nothing in `@civts/core`
 * ranks players, and victory conditions are M10's work (`@civts/sim`'s batch module says the
 * same thing about win counts). Inventing a points formula in the UI would be a **game rule
 * living in the presentation layer** — the exact thing this package's hard rule forbids — and
 * it would be a rule no test, no AI and no future milestone could see or agree with.
 *
 * So the table reports what the engine *does* know, as counts and totals read straight off
 * the state: cities, units, population, treasury, techs, beakers. Every figure is a direct
 * read (a `length`, a `sum`, a stored field) with no weighting, no rounding and no formula.
 * When M10 gives scoring a home, the column arrives from there.
 *
 * ## Totals are sums of engine values, not new rules
 *
 * Population is the sum of the player's cities' `population`; the unit count sums the units
 * that player owns. Both are arithmetic over stored fields — the same kind of reading
 * `textview.ts` does — and neither consults terrain, buildings or the catalog.
 */

import { civPlayers, type GameState, type PlayerId } from '@civts/core';
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
}

/**
 * Every player in `state.players` order (which is player-id order), barbarians included.
 *
 * The barbarian row is shown rather than hidden for the same reason the state gives it a
 * `treasury` and an `explored` row: one shape for every player, and a scoreboard that
 * silently omitted a player with units on the map would be a table that disagrees with the
 * world it describes.
 */
export const scoreboardRows = (state: GameState): readonly ScoreRow[] =>
  state.players.map((player) => {
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
    };
  });

/** The civilizations only — the rows a player can actually be on the scoreboard with. */
export const civilizationRows = (state: GameState): readonly ScoreRow[] => {
  const civs = new Set<number>(civPlayers(state).map((player) => Number(player.id)));
  return scoreboardRows(state).filter((row) => civs.has(Number(row.id)));
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
    for (const row of scoreboardRows(state)) {
      const tr = el(doc, 'tr');
      const values: readonly string[] = [
        row.player,
        String(row.cities),
        String(row.units),
        String(row.population),
        String(row.treasury),
        String(row.techs),
        String(row.beakers),
      ];
      for (const value of values) tr.append(el(doc, 'td', value));
      body.append(tr);
    }
  };

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, refresh };
};
