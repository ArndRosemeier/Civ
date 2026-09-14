/**
 * The city screen: worked tiles, production, the queue — and the yields the **engine**
 * computed.
 * See docs/INTERFACES.md, M8 ("The accessibility contract": `list`/`Cities`,
 * `dialog`/`City <name>`) and M3's city rules (`cityYields`, `workedTiles`,
 * `ProductionItem`).
 *
 * ## No number on this screen is computed here
 *
 * The A4 line is explicit — "the yields shown must come from the ENGINE's own readouts,
 * never recomputed" — so every figure comes from a `core` function:
 *
 * - the output triple and the surplus are `cityYields(state, ruleset, cityId)`;
 * - the growth box target is `cityGrowthTarget` over the engine's own `foodBoxSize` curve
 *   and the city's buildings, never a second threshold derived here;
 * - an item's price is `itemCost(ruleset, item)`;
 * - what a city **may build** is `cityProductionOptions(state, ruleset, cityId)` — the
 *   engine's own menu, assembled by filtering its catalog through `planSetProduction`, so a
 *   resource- or tech-gated item is absent rather than greyed out by a UI guess;
 * - whether a tile may be worked is `planSetWorkedTiles(state, playerId, cityId, tiles)`
 *   asked about the assignment the control would write.
 *
 * That last one is the interesting case, and it is why worked tiles are *checkboxes whose
 * legal next assignment the engine approves* rather than clickable tiles: the UI builds the
 * candidate list (`workedTiles ± tile`, an edit of the state's own list) and asks the
 * engine's planner whether the result is legal. A tile whose toggle the planner refuses is
 * rendered `disabled`, so the control cannot offer an action the applier would reject —
 * which is the keystone rule of this whole package. The controls are rebuilt on every
 * refresh, so a checkbox always dispatches the assignment the current state implies rather
 * than one captured when the dialog was opened.
 */

import {
  buildingCatalog,
  cityById,
  cityGrowthTarget,
  cityProductionOptions,
  cityRadius,
  cityYields,
  foodBoxSize,
  happinessOf,
  indexToX,
  indexToY,
  itemCost,
  planSetWorkedTiles,
  playerCulture,
  wholeCulture,
  type CityId,
  type GameState,
  type PlayerId,
  type ProductionItem,
  type RulesetView,
  type TileIndex,
} from '@civts/core';
import { productionItemName } from '../events.js';
import { commandsClosed } from './closed.js';
import type { PanelContext } from './index.js';

/** One entry of the `Cities` list. */
export interface CityListEntry {
  readonly id: CityId;
  readonly name: string;
  readonly population: number;
  /** `Granary (building)`, or absent when the city is building nothing. */
  readonly building?: string;
}

/**
 * The acting player's cities, in `state.cities` order (sorted by id). Other players'
 * cities are deliberately absent: the list is the *entry point* to a screen whose every
 * control issues a command as this player, and a list that offered a city the player does
 * not own would offer a dialog whose commands the engine refuses (`not-your-city`).
 */
export const cityListEntries = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly CityListEntry[] => {
  const entries: CityListEntry[] = [];
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    entries.push({
      id: city.id,
      name: city.name,
      population: city.population,
      ...(city.production === undefined
        ? {}
        : { building: productionItemName(ruleset, city.production) }),
    });
  }
  return entries;
};

/** One labelled figure on the city screen: `Food`, `5 (+1 per turn)`. */
export interface CityFact {
  readonly label: string;
  readonly value: string;
}

/**
 * The city's readouts, straight from the engine. `undefined` when the state holds no such
 * city — the honest answer for a query about a city that is not there, and the same reading
 * `cityYields` takes.
 *
 * **M9 added culture and happiness, and neither is recomputed here.** `happinessOf` is
 * `happiness.ts`' one verdict on a city's citizens — the same call `cityYields` makes to decide
 * whether the city is in disorder, so the number on this screen and the number the production,
 * growth and money loops acted on are one number. Its `disordered` field IS what the engine's
 * `isDisordered(state, ruleset, cityId)` returns (that function is this same read by id), so the
 * panel asks once rather than twice. Culture is `city.culture` read through `wholeCulture` — the
 * total reading `culture.ts` takes of a value a save may have carried anything in — beside
 * `playerCulture`, the derived sum the cultural victory threshold is measured against. There is
 * deliberately no stored player total for this panel to disagree with; the contract says why.
 */
export const cityFacts = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
): readonly CityFact[] | undefined => {
  const city = cityById(state, cityId);
  if (city === undefined) return undefined;

  const yields = cityYields(state, ruleset, cityId);
  const target = cityGrowthTarget(buildingCatalog(ruleset), city, foodBoxSize(city.population));
  const mood = happinessOf(state, ruleset, city);
  const cityCulture = wholeCulture(city.culture);
  const allCities = playerCulture(state, city.owner);

  return [
    { label: 'Population', value: String(city.population) },
    {
      label: 'Food',
      value: `${String(yields.food)} (${yields.foodSurplus >= 0 ? '+' : ''}${String(yields.foodSurplus)} per turn)`,
    },
    { label: 'Shields', value: String(yields.shields) },
    { label: 'Commerce', value: String(yields.commerce) },
    { label: 'Food box', value: `${String(city.foodBox)} / ${String(target)}` },
    { label: 'Stored shields', value: String(city.shields) },
    { label: 'Buildings', value: String(city.buildings.length) },
    {
      label: 'Culture',
      value: `${String(cityCulture)} here, ${String(allCities)} in all your cities`,
    },
    {
      label: 'Happiness',
      value: `${String(mood.happy)} happy, ${String(mood.content)} content, ${String(mood.unhappy)} unhappy`,
    },
    {
      label: 'Disorder',
      value: mood.disordered
        ? 'civil disorder — no shields, no beakers, no gold and no growth this turn'
        : 'in good order',
    },
  ];
};

/** One workable tile, and whether the assignment its toggle would write is legal. */
export interface WorkedTileOption {
  readonly tile: TileIndex;
  /** `3,4` — the coordinate the control's label uses. */
  readonly text: string;
  readonly worked: boolean;
  /** The engine's verdict on the assignment this control would write. */
  readonly legal: boolean;
  /** What the control would dispatch: `workedTiles` without this tile, or with it. */
  readonly next: readonly TileIndex[];
}

/**
 * Every tile in the city's radius (`cityRadius`, the engine's geometry), with the state's own
 * `workedTiles` and the planner's verdict on the toggle.
 *
 * A tile another city works is *not* skipped here: it is offered and the planner refuses it
 * (`tile-worked-by-another-city`), which renders as a disabled control. Filtering it out
 * would be this file deciding a legality question the engine already answers.
 */
export const workedTileOptions = (
  state: GameState,
  playerId: PlayerId,
  cityId: CityId,
): readonly WorkedTileOption[] => {
  const city = cityById(state, cityId);
  if (city === undefined) return [];

  const worked = new Set<number>(city.workedTiles.map((tile) => Number(tile)));
  return cityRadius(state, city.tile).map((tile) => {
    const isWorked = worked.has(Number(tile));
    const next = isWorked
      ? city.workedTiles.filter((candidate) => candidate !== tile)
      : [...city.workedTiles, tile];
    return {
      tile,
      text: `${String(indexToX(state.map, tile))},${String(indexToY(state.map, tile))}`,
      worked: isWorked,
      // M9: the planner now also refuses a tile **another player owns**, so a checkbox the
      // panel disables is one the applier would refuse — the UI keystone, with one more
      // rule behind the same call. (M9's claim radius does not narrow the ring; it decides
      // who the ring's tiles belong to.)
      legal: planSetWorkedTiles(state, playerId, cityId, next).ok,
      next,
    };
  });
};

/** One buildable item: what the engine's menu offers, with the engine's price. */
export interface ProductionChoice {
  readonly item: ProductionItem;
  /** `Granary (building)` — the same spelling the queue and the log use. */
  readonly label: string;
  readonly cost: number;
}

/** The engine's own production menu for this city — see the module note. */
export const productionChoices = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
): readonly ProductionChoice[] =>
  cityProductionOptions(state, ruleset, cityId).map((item) => ({
    item,
    label: productionItemName(ruleset, item),
    cost: itemCost(ruleset, item),
  }));

/** One entry of the displayed queue. */
export interface QueueEntry {
  readonly item: ProductionItem;
  readonly label: string;
  readonly cost: number;
  readonly current: boolean;
}

/**
 * The item the city is building right now, or `undefined` when it is idle.
 *
 * `city.production` is a *separate field* from `city.queue`, and M3 froze that: `SetProduction`
 * sets the former and leaves the latter alone. The screen keeps them apart for the same reason —
 * a panel that merged them would be showing a queue the engine does not have.
 */
export const buildingEntry = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
): QueueEntry | undefined => {
  const city = cityById(state, cityId);
  if (city === undefined || city.production === undefined) return undefined;
  return {
    item: city.production,
    label: productionItemName(ruleset, city.production),
    cost: itemCost(ruleset, city.production),
    current: true,
  };
};

/** The items queued *behind* the current build, in `city.queue`'s own FIFO order. */
export const queueEntries = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
): readonly QueueEntry[] => {
  const city = cityById(state, cityId);
  if (city === undefined) return [];
  return city.queue.map((item) => ({
    item,
    label: productionItemName(ruleset, item),
    cost: itemCost(ruleset, item),
    current: false,
  }));
};

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

export interface CityPanelHandle {
  readonly list: HTMLElement;
  readonly dialog: HTMLDialogElement;
  refresh(): void;
  /** Open the screen for `cityId` (the city-list buttons' action and the app's own hook). */
  open(cityId: CityId): void;
  /** The city whose screen is open, or `undefined` — the app reads it to follow along. */
  opened(): CityId | undefined;
}

/**
 * Mount the city list and the (single, reused) city screen into `parent`.
 *
 * One dialog element serves every city: it is a native `<dialog>` (so its role is `dialog`),
 * its accessible name is `City <name>` — the frozen contract's spelling — and opening it
 * sets that name, re-renders the contents from the current state and calls `show()`.
 * A dialog per city would multiply the elements a test has to disambiguate for no benefit:
 * only one city screen is ever open in this UI.
 *
 * **`show()`, not `showModal()`.** A modal dialog makes every other element inert, and these
 * panels are side screens of a game that is still being played: the map, `End turn` and the
 * unit orders all stay usable while a city, the tech tree or the debug panel is open — which is
 * also what lets a test drive the game on while a panel is up. The dialog is still a real
 * `<dialog>` with the contract's role and name, and each one has a `Close` control.
 */
export const mountCityPanel = (parent: HTMLElement, ctx: PanelContext): CityPanelHandle => {
  const doc = parent.ownerDocument;
  const wrapper = el(doc, 'section');
  wrapper.dataset['panel'] = 'cities';

  const list = el(doc, 'ul');
  list.setAttribute('aria-label', 'Cities');

  const dialog = doc.createElement('dialog');
  dialog.dataset['panel'] = 'city';
  const title = el(doc, 'h2');
  const close = el(doc, 'button', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });
  const facts = el(doc, 'dl');
  const tiles = el(doc, 'fieldset');
  const production = el(doc, 'fieldset');
  const queue = el(doc, 'section');
  queue.setAttribute('aria-label', 'Production queue');
  dialog.append(title, close, facts, tiles, production, queue);

  wrapper.append(el(doc, 'h2', 'Cities'), list, dialog);
  parent.append(wrapper);

  let openCityId: CityId | undefined;

  const refresh = (): void => {
    const state = ctx.api.state();
    const ruleset = ctx.api.ruleset;
    const playerId = ctx.api.playerId();

    list.replaceChildren();
    for (const entry of cityListEntries(state, ruleset, playerId)) {
      const item = el(doc, 'li');
      const button = el(doc, 'button', entry.name);
      button.type = 'button';
      button.addEventListener('click', () => {
        open(entry.id);
      });
      item.append(
        button,
        el(
          doc,
          'span',
          ` — ${String(entry.population)} ${entry.population === 1 ? 'citizen' : 'citizens'}${
            entry.building === undefined ? '' : `, building ${entry.building}`
          }`,
        ),
      );
      list.append(item);
    }

    const cityId = openCityId;
    const city = cityId === undefined ? undefined : cityById(state, cityId);
    if (cityId === undefined) return;
    if (city === undefined) {
      // **The world this screen belonged to is gone, so the screen goes with it.** This used to
      // return early and leave the dialog up, which left its controls offering orders for a city the
      // engine no longer has: a `Build …` control dispatched `SetProduction` for city 0 in a state
      // with no cities at all, and `applyCommand` refused it as `unknown-city`. That is the keystone
      // invariant's offered direction broken in two clicks a player can make on purpose —
      // `New game` → `Start new game` (and the same through `Load game`, which replaces the state
      // the same way). Found by `e2e/m8-adversarial.spec.ts`, whose page-wide sweep reordered when
      // phase 5 added two controls to the header: the sweep reached the new-game dialog before the
      // city screen's controls and reported twelve refusals. Recorded in `docs/KNOWN-ISSUES.md`.
      openCityId = undefined;
      dialog.close();
      return;
    }

    // M10: once the engine has ended the game it refuses every command, so the tile checkboxes and
    // the production buttons below are rendered disabled — closed, not hidden, because "what this
    // city could have built" is still a true statement about the final position.
    const closed = commandsClosed(ctx.api);

    dialog.setAttribute('aria-label', `City ${city.name}`);
    title.textContent = city.name;

    facts.replaceChildren();
    for (const fact of cityFacts(state, ruleset, cityId) ?? []) {
      facts.append(el(doc, 'dt', fact.label), el(doc, 'dd', fact.value));
    }

    tiles.replaceChildren(el(doc, 'legend', 'Worked tiles'));
    for (const option of workedTileOptions(state, playerId, cityId)) {
      const label = el(doc, 'label');
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.checked = option.worked;
      // An explicit `aria-label` as well as the wrapping `<label>`: the accessible name is the
      // same either way, and a test that reads the attribute (rather than computing the name)
      // then sees the tile the control names instead of having to walk to its parent.
      input.setAttribute('aria-label', `Work tile ${option.text}`);
      // The engine's verdict, rendered as a disabled control rather than as a hidden one:
      // the tile is real, the assignment is not legal, and a player can see both facts.
      input.disabled = !option.legal || closed;
      input.dataset['tile'] = String(option.tile);
      input.addEventListener('change', () => {
        ctx.dispatch({ type: 'SetWorkedTiles', cityId, tiles: option.next });
      });
      label.append(input, ` Work tile ${option.text}`);
      tiles.append(label);
    }

    production.replaceChildren(el(doc, 'legend', 'Production'));
    for (const choice of productionChoices(state, ruleset, cityId)) {
      const button = el(doc, 'button', `Build ${choice.label} (${String(choice.cost)} shields)`);
      button.type = 'button';
      button.disabled = closed;
      button.addEventListener('click', () => {
        ctx.dispatch({ type: 'SetProduction', cityId, item: choice.item });
      });
      production.append(button);
    }

    // Two labelled parts, because the state has two fields: what is being built now, and what is
    // queued behind it. Merging them would render a queue the engine does not have.
    const building = buildingEntry(state, ruleset, cityId);
    const entries = queueEntries(state, ruleset, cityId);
    const queueNodes: readonly HTMLElement[] = [
      el(doc, 'h3', 'Building now'),
      building === undefined
        ? el(doc, 'p', 'Nothing is being built.')
        : el(doc, 'p', `${building.label} (${String(building.cost)} shields)`),
      el(doc, 'h3', 'Queue'),
    ];
    const queueList = el(doc, 'ol');
    for (const entry of entries) {
      queueList.append(el(doc, 'li', `${entry.label} (${String(entry.cost)} shields)`));
    }
    // `replaceChildren` rather than `append`: this section is re-rendered on every state change,
    // and appending would stack each frame's copy on top of the last one's.
    queue.replaceChildren(
      ...queueNodes,
      ...(entries.length === 0 ? [el(doc, 'p', 'The queue is empty.')] : [queueList]),
    );
  };

  const open = (cityId: CityId): void => {
    openCityId = cityId;
    refresh();
    if (!dialog.open) dialog.show();
  };

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { list, dialog, refresh, open, opened: () => openCityId };
};
