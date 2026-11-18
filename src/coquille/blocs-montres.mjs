// MONTRER et CACHER les blocs de l'écran du parcours (#193, ADR 0040), côté page de confiance.
//
// Extrait de `public/coquille/parcours-de-la-page.mjs` (#265, relecture de #308) pour que Node
// l'éprouve sur une page factice : ce qui disparaît de l'écran n'y laisse pas de demande périmée.

import { suivreLaConfirmationDeRevocation } from "./confirmation-de-la-revocation.mjs";
import { poserLaSortie } from "./sortie-de-la-revocation.mjs";

/** Les sections qui regroupent des blocs : cachées quand aucun de leurs blocs n'est montré. */
export const SECTIONS = ["deverrouillage", "feuille", "cycle", "portabilite"];

/**
 * Montre et cache les blocs, PUIS écrit ce que dit la révocation et oublie sa demande si son bloc a
 * disparu : l'ordre compte (l'oubli lit l'état des blocs qu'on vient de poser).
 *
 * @param {{ doc: { querySelectorAll: (s: string) => Iterable<any> },
 *           noeud: (id: string) => any, visibles: readonly string[], vueComplete: boolean,
 *           dire: (id: string, texte: string) => void, releve: object,
 *           revocation?: { sortieFermee: (id: string) => boolean } }} page
 */
export function montrerLesBlocs({ doc, noeud, visibles, vueComplete, dire, releve, revocation }) {
  for (const element of doc.querySelectorAll("[data-bloc]")) {
    element.hidden = !vueComplete && !visibles.includes(element.dataset.bloc);
  }
  for (const id of SECTIONS) {
    const section = noeud(id);
    if (section === null) continue;
    section.hidden =
      !vueComplete && ![...section.querySelectorAll("[data-bloc]")].some((bloc) => !bloc.hidden);
  }
  suivreLaConfirmationDeRevocation({ noeud, dire, releve });
  if (revocation !== undefined) poserLaSortie({ noeud, revocation });
}
