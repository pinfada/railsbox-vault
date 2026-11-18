// Les gestes de SORTIE de l'étape 9 pendant et après une révocation (#265, relecture de #308).
//
// La GARDE est dans chaque gestionnaire (`geste-du-parcours.mjs`), sur l'état unique de
// `etat-de-la-revocation.mjs`. Ce module POSE seulement `disabled`, pour la personne : un bouton
// fermé se voit fermé, mais n'est pas ce qui garde la sortie.

import { GESTE_QUI_DIT_RIEN } from "./etat-de-la-revocation.mjs";

const RETOUR = "parcours-retour-application";

/**
 * @param {{ noeud: (id: string) => any, revocation: { sortieFermee: (id: string) => boolean } }} page
 */
export function poserLaSortie({ noeud, revocation }) {
  for (const id of [GESTE_QUI_DIT_RIEN, RETOUR]) {
    const bouton = noeud(id);
    if (bouton !== null && bouton !== undefined) bouton.disabled = revocation.sortieFermee(id);
  }
}
