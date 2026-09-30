import { changeDiplomacy, relationOf, type DiplomaticOrder } from '@civts/core';
import type { PanelContext } from './index.js';
import { commandsClosed } from './closed.js';

export const mountDiplomacy = (
  parent: HTMLElement,
  ctx: PanelContext,
): { element: HTMLElement; refresh(): void } => {
  const doc = parent.ownerDocument;
  const section = doc.createElement('section');
  section.setAttribute('aria-label', 'Diplomacy');
  section.dataset['panel'] = 'diplomacy';
  parent.append(section);
  return {
    element: section,
    refresh() {
      section.replaceChildren();
      const heading = doc.createElement('h2');
      heading.textContent = 'Diplomacy';
      section.append(heading);
      const state = ctx.api.state();
      const actor = ctx.api.playerId();
      for (const player of state.players) {
        if (player.kind !== 'civ' || player.id === actor) continue;
        const relation = relationOf(state, actor, player.id);
        const row = doc.createElement('div');
        row.dataset['role'] = 'diplomatic-relation';
        row.dataset['relation'] = relation.status;
        const name = doc.createElement('h3');
        name.textContent = player.name;
        const status = doc.createElement('p');
        status.textContent = `${relation.status === 'peace' ? 'At peace' : 'At war'}${relation.offer !== undefined ? ' · Peace offer pending' : ''}`;
        row.append(name, status);
        const orders: readonly DiplomaticOrder[] =
          relation.status === 'peace'
            ? ['DeclareWar']
            : relation.offer === player.id
              ? ['AcceptPeace']
              : ['OfferPeace'];
        for (const order of orders) {
          const button = doc.createElement('button');
          button.textContent = {
            DeclareWar: 'Declare war',
            OfferPeace: 'Offer peace',
            AcceptPeace: 'Accept peace',
          }[order];
          button.setAttribute('aria-label', `${button.textContent} with ${player.name}`);
          button.disabled =
            commandsClosed(ctx.api) || !changeDiplomacy(state, actor, player.id, order).ok;
          button.addEventListener('click', () =>
            ctx.dispatch({ type: order, targetPlayer: player.id }),
          );
          row.append(button);
        }
        section.append(row);
      }
    },
  };
};
