import { changeDiplomacy, relationOf, type DiplomaticOrder } from '@civts/core';
import type { PanelContext } from './index.js';
import { commandsClosed } from './closed.js';

export const mountDiplomacy = (parent: HTMLElement, ctx: PanelContext): { refresh(): void } => {
  const doc = parent.ownerDocument;
  const section = doc.createElement('section');
  section.setAttribute('aria-label', 'Diplomacy');
  parent.append(section);
  return {
    refresh() {
      section.replaceChildren();
      const heading = doc.createElement('h3');
      heading.textContent = 'Diplomacy';
      section.append(heading);
      const state = ctx.api.state();
      const actor = ctx.api.playerId();
      for (const player of state.players) {
        if (player.kind !== 'civ' || player.id === actor) continue;
        const relation = relationOf(state, actor, player.id);
        const row = doc.createElement('div');
        row.append(
          `${player.name}: ${relation.status}${relation.offer !== undefined ? ' — peace offer pending' : ''} `,
        );
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
