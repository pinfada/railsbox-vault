// La LIAISON du cycle sur la table de la révocation (#265, C2-2 ; revue de #321, point 2).
//
// Le verrouillage recharge la coquille : demandé pendant l'envoi d'une révocation ou pendant une modification
// de l'enveloppe, il couperait l'écriture. La table de C1 le dit (e14, « verrouiller » est refusé en V, FM, SM
// et RM) ; ce module est le SEUL endroit où cette décision est transmise au cycle. Il vit dans `src/` pour que
// la campagne de mutation puisse la couper : une liaison dans la page ne serait mutée par personne. Le cycle,
// lui, REFUSE de se brancher sans elle (`brancherLesGestesDuCycle`) : si ce module cessait d'être appelé, la
// page ne démarrerait plus, au lieu de laisser passer un verrouillage.

import { brancherLesGestesDuCycle } from "./gestes-du-cycle.mjs";

/**
 * @param {{ revocation: { appliquer: (evenement: { type: string }) => { accepte: boolean } } } & object} appel
 *   `revocation` : le câblage de la révocation ; le reste est la liaison de `brancherLesGestesDuCycle`
 */
export function brancherLeCycleSurLaRevocation({ revocation, ...liaison }) {
  return brancherLesGestesDuCycle({
    ...liaison,
    // Après l'étalement : la liaison de l'appelant ne peut pas contourner la table.
    accepteLeVerrouillage: () => revocation.appliquer({ type: "verrouiller" }).accepte === true,
  });
}
