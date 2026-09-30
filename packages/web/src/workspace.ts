import type { PanelsElements } from './panels/index.js';

/** Arrange existing controls without duplicating state or command handling. */
export const arrangeWorkspace = (
  root: HTMLElement,
  sidebar: HTMLElement,
  stack: HTMLElement,
  dock: HTMLElement,
  elements: PanelsElements,
  controls: {
    endTurn: HTMLButtonElement;
    nextUnit: HTMLButtonElement;
    grid: HTMLButtonElement;
    keyboard: HTMLButtonElement;
    order: HTMLElement;
  },
): void => {
  const doc = root.ownerDocument;
  const header = root.querySelector('header');
  if (header === null) return;
  const tools = doc.createElement('div');
  tools.dataset['layout'] = 'global-tools';
  for (const button of elements.save.querySelectorAll('button')) {
    button.setAttribute('aria-label', button.textContent);
    button.textContent = button.textContent === 'Save game' ? 'Save' : 'Load';
    tools.append(button);
  }
  header.append(elements.statusbar, tools);
  const mapTools = doc.createElement('div');
  mapTools.dataset['layout'] = 'map-tools';
  mapTools.append(controls.order, controls.grid, controls.keyboard);
  const saveStatus = elements.save.querySelector<HTMLElement>('[data-role="save-status"]');
  if (saveStatus !== null) mapTools.prepend(saveStatus);
  const sessionTitle = elements.save.querySelector('h2');
  if (sessionTitle !== null) sessionTitle.textContent = 'Your session';
  const sessionHint = doc.createElement('p');
  sessionHint.textContent =
    'Save and load using the controls above. Saved games are stored in this browser.';
  elements.save.append(sessionHint);
  const hashStatus = elements.debug.querySelector<HTMLElement>('[data-role="state-hash"]');
  if (hashStatus !== null)
    elements.debugDialog.insertBefore(hashStatus, elements.debugDialog.querySelector('dl'));
  root.querySelector('[data-layout="map-column"]')?.append(mapTools);

  const heading = doc.createElement('div');
  heading.dataset['layout'] = 'sidebar-heading';
  heading.textContent = 'Civilization command';
  const nav = doc.createElement('div');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Civilization views');
  const views: readonly [string, HTMLElement[]][] = [
    [
      'Overview',
      [
        elements.units,
        ...(elements.cities.parentElement === null ? [] : [elements.cities.parentElement]),
      ],
    ],
    ['Empire', [elements.rates, elements.government]],
    ['Diplomacy', [elements.diplomacy, elements.scoreboard]],
    ['History', [elements.events]],
    ['Game', [elements.save, elements.debug]],
  ];
  const buttons: HTMLButtonElement[] = [];
  const pages: HTMLElement[] = [];
  const activate = (index: number): void => {
    for (const dialog of dock.querySelectorAll('dialog[open]'))
      (dialog as HTMLDialogElement).close();
    buttons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
      const page = pages[i];
      if (page !== undefined) page.hidden = i !== index;
    });
  };
  views.forEach(([name, children], index) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.id = `view-tab-${String(index)}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `view-page-${String(index)}`);
    const page = doc.createElement('div');
    page.id = `view-page-${String(index)}`;
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', button.id);
    page.append(...children);
    button.addEventListener('click', () => {
      activate(index);
    });
    button.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % views.length
          : event.key === 'ArrowLeft'
            ? (index + views.length - 1) % views.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? views.length - 1
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      activate(next);
      buttons[next]?.focus();
    });
    buttons.push(button);
    pages.push(page);
    nav.append(button);
    stack.append(page);
  });
  const footer = doc.createElement('div');
  footer.dataset['layout'] = 'sidebar-footer';
  const hint = doc.createElement('p');
  hint.textContent = 'Research & discoveries';
  const actions = doc.createElement('div');
  actions.dataset['layout'] = 'turn-actions';
  actions.append(controls.nextUnit, controls.endTurn);
  footer.append(hint, elements.technology, actions);
  sidebar.prepend(heading, nav);
  const body = doc.createElement('div');
  body.dataset['layout'] = 'sidebar-body';
  body.append(stack, dock);
  sidebar.append(body);
  sidebar.append(footer);
  activate(0);
  const Observer = doc.defaultView?.MutationObserver;
  if (Observer !== undefined)
    new Observer((records) => {
      const opened = records
        .map((record) => record.target)
        .filter(
          (target): target is HTMLDialogElement =>
            target instanceof HTMLDialogElement && target.open,
        )
        .at(-1);
      if (opened !== undefined) {
        for (const dialog of dock.querySelectorAll('dialog[open]'))
          if (dialog !== opened) (dialog as HTMLDialogElement).close();
      }
      stack.inert = dock.querySelector('dialog[open]') !== null;
      stack.setAttribute('aria-hidden', String(stack.inert));
    }).observe(dock, { subtree: true, attributes: true, attributeFilter: ['open'] });
};
