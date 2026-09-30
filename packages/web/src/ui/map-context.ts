import {
  indexToX,
  indexToY,
  isGameOver,
  unitActions,
  type Command,
  type GameState,
  type PlayerId,
  type RulesetView,
  type TileIndex,
  type UnitId,
  type CityId,
} from '@civts/core';
import { unitName } from '../events.js';
import { startStack } from './stack.js';
import { tileNamedBy } from './schema.js';

export function mountMapContext(
  root: HTMLElement,
  actions: HTMLElement,
  api: {
    state(): GameState;
    ruleset: RulesetView;
    player(): PlayerId | undefined;
    selected(): UnitId | undefined;
    select(id: UnitId | undefined): void;
    dispatch(command: Command): void;
    move(ids: readonly UnitId[], to: TileIndex): void;
    city(id: CityId): void;
  },
) {
  const doc = root.ownerDocument;
  const menu = doc.createElement('section');
  menu.className = 'map-context';
  menu.hidden = true;
  menu.setAttribute('role', 'region');
  menu.setAttribute('aria-label', 'Tile options');
  root.append(menu);
  let tile: TileIndex | undefined;
  let anchor = { x: 0, y: 0 };
  let selected: UnitId[] = [];
  let primary: UnitId | undefined;
  const button = (label: string, action: () => void) => {
    const control = doc.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', action);
    return control;
  };
  const close = () => {
    menu.hidden = true;
    root.append(actions);
    actions.removeAttribute('data-context-actions');
  };
  const ids = (): readonly UnitId[] => {
    if (api.selected() !== primary) {
      primary = api.selected();
      selected = primary === undefined ? [] : [primary];
    }
    selected = selected.filter((id) =>
      api.state().units.some((unit) => unit.id === id && unit.owner === api.player()),
    );
    return selected;
  };
  const position = () => {
    const box = root.getBoundingClientRect();
    menu.style.left = `${String(Math.max(box.left + 6, Math.min(anchor.x + 12, box.right - menu.offsetWidth - 6)))}px`;
    menu.style.top = `${String(Math.max(box.top + 6, Math.min(anchor.y + 12, box.bottom - menu.offsetHeight - 6)))}px`;
  };
  const refresh = () => {
    if (menu.hidden || tile === undefined) return;
    const active = doc.activeElement;
    const focusedName =
      active !== null && menu.contains(active)
        ? (active.getAttribute('aria-label') ?? active.textContent)
        : null;
    const listScroll = menu.querySelector<HTMLElement>('.map-context-units')?.scrollTop ?? 0;
    const state = api.state();
    const target = tile;
    const chosen = ids();
    menu.replaceChildren();
    const heading = doc.createElement('div');
    heading.className = 'map-context-heading';
    heading.textContent = `Tile ${String(indexToX(state.map, target))},${String(indexToY(state.map, target))}`;
    heading.append(button('Close tile options', close));
    menu.append(heading);
    const city = state.cities.find((each) => each.tile === target && each.owner === api.player());
    if (city !== undefined)
      menu.append(
        button(`Open city ${city.name}`, () => {
          close();
          api.city(city.id);
        }),
      );
    const units = state.units.filter((each) => each.tile === target && each.owner === api.player());
    if (units.length > 0) {
      const tools = doc.createElement('div');
      tools.className = 'map-context-tools';
      const choose = (next: UnitId[]) => {
        selected = next;
        // Keep the inspector's default separate from an empty map selection.
        primary = next[0] ?? api.selected();
        api.select(primary);
        refresh();
      };
      tools.append(
        button('Select all units here', () => {
          choose(units.map((unit) => unit.id));
        }),
        button('Clear selection', () => {
          choose([]);
        }),
      );
      menu.append(tools);
      const list = doc.createElement('div');
      list.className = 'map-context-units';
      for (const unit of units) {
        const row = doc.createElement('label');
        const check = doc.createElement('input');
        check.type = 'checkbox';
        check.checked = chosen.includes(unit.id);
        check.setAttribute('aria-label', `Select ${unitName(state, api.ruleset, unit.id)}`);
        check.addEventListener('change', () => {
          choose(
            check.checked
              ? [...ids().filter((id) => units.some((each) => each.id === id)), unit.id]
              : ids().filter((id) => id !== unit.id),
          );
        });
        row.append(
          check,
          `${unitName(state, api.ruleset, unit.id)} · ${String(unit.movementLeft)} moves`,
        );
        list.append(row);
      }
      menu.append(list);
    }
    const status = doc.createElement('p');
    status.textContent =
      chosen.length > 0
        ? `${String(chosen.length)} selected · choose a destination on the map, then Move here.`
        : 'Select a unit on the map to give orders.';
    menu.append(status);
    if (chosen.length > 0 && !isGameOver(state, api.ruleset)) {
      const route = startStack(state, api.ruleset, chosen, target);
      if (typeof route !== 'string' && route.route.length > 0) {
        menu.append(
          button(
            chosen.length > 1 ? `Move ${String(chosen.length)} units here` : 'Move here',
            () => {
              const members = [...ids()];
              close();
              api.move(members, target);
            },
          ),
        );
      } else if (typeof route === 'string' && units.length === 0) {
        const reason = doc.createElement('p');
        reason.className = 'map-context-reason';
        reason.textContent = route;
        menu.append(reason);
      }
      if (chosen.length === 1 && primary !== undefined) {
        for (const action of unitActions(state, api.ruleset, primary)) {
          if (action.type === 'AttackUnit' && tileNamedBy(action) === target)
            menu.append(
              button('Attack here', () => {
                close();
                api.dispatch(action);
              }),
            );
        }
      }
    }
    if (units.some((unit) => unit.id === primary) && chosen.length === 1) {
      actions.dataset['contextActions'] = '';
      actions.hidden = false;
      menu.append(actions);
    } else {
      root.append(actions);
      actions.hidden = true;
    }
    position();
    const list = menu.querySelector<HTMLElement>('.map-context-units');
    if (list !== null) list.scrollTop = listScroll;
    if (focusedName !== null) {
      const control = Array.from(menu.querySelectorAll<HTMLElement>('button,input')).find(
        (element) => (element.getAttribute('aria-label') ?? element.textContent) === focusedName,
      );
      control?.focus({ preventScroll: true });
    }
  };
  return {
    close,
    reset() {
      close();
      primary = api.selected();
      selected = primary === undefined ? [] : [primary];
    },
    refresh,
    ids,
    isOpen: () => !menu.hidden,
    open(target: TileIndex, x: number, y: number) {
      tile = target;
      anchor = { x, y };
      ids();
      const own = api
        .state()
        .units.filter((unit) => unit.tile === target && unit.owner === api.player());
      if (own.length > 0 && selected.length === 0) {
        primary = own[0]?.id;
        selected = primary === undefined ? [] : [primary];
        api.select(primary);
      }
      menu.hidden = false;
      refresh();
    },
  };
}
