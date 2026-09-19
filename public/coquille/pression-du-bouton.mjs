// Un bouton PRESSÉ ne change pas sous le doigt (#251).
//
// Un clic est un appui PUIS un relâchement sur le même bouton. Si, entre les deux, la page le ferme
// (`disabled`), le cache, ou déplace ce qui l'entoure, le navigateur ne livre aucun `click` — et la
// personne n'a aucun signe : elle croit son coffre verrouillé alors qu'il est ouvert. La recette QA
// de la PR #249 l'a vu quatre fois ; l'épreuve `tests/browser/coquille-premier-clic.spec.mjs` le
// reproduit par un relevé publié pendant la pression, qui fait RENDRE la page.
//
// Ce module ne décide rien : tant qu'un bouton est pressé, il RETIENT les écritures du parcours et
// son rendu, puis les rejoue juste après le `click` — une tâche plus tard, le `click` étant livré
// dans la même tâche que le relâchement. Un appui jamais relâché (pointeur sorti de la fenêtre) est
// libéré au bout de `DELAI_MAX_MS`. Le clavier n'est pas concerné : Entrée et Espace ne pressent rien.

/** Au-delà, un appui sans relâchement ne retient plus rien. */
export const DELAI_MAX_MS = 2_000;

/**
 * Surveille les appuis sur les boutons du document.
 *
 * @param {Document} doc
 * @returns {{ differer: (cle: string, ecrire: () => void) => void,
 *             differerLeRendu: (rendre: () => void) => boolean }}
 */
export function surveillerLaPression(doc) {
  const pression = { bouton: null, ecritures: new Map(), rendu: null, minuterie: null };

  function relacher() {
    if (pression.bouton === null) return;
    pression.bouton = null;
    clearTimeout(pression.minuterie);
    const ecritures = [...pression.ecritures.values()];
    pression.ecritures.clear();
    for (const ecrire of ecritures) ecrire();
    const rendu = pression.rendu;
    pression.rendu = null;
    rendu?.();
  }

  doc.addEventListener(
    "pointerdown",
    (evenement) => {
      if (evenement.button !== 0 || !(evenement.target instanceof Element)) return;
      const bouton = evenement.target.closest("button");
      if (bouton === null) return;
      pression.bouton = bouton;
      clearTimeout(pression.minuterie);
      pression.minuterie = setTimeout(relacher, DELAI_MAX_MS);
    },
    { capture: true },
  );
  // Le `click` suit le relâchement DANS LA MÊME TÂCHE : rejouer une tâche plus tard le laisse passer.
  const relacherApresLeClic = () => {
    if (pression.bouton !== null) setTimeout(relacher, 0);
  };
  doc.addEventListener("pointerup", relacherApresLeClic, { capture: true });
  doc.addEventListener("pointercancel", relacherApresLeClic, { capture: true });

  return Object.freeze({
    /** Écrit tout de suite, ou retient l'écriture jusqu'au relâchement ; la dernière gagne. */
    differer(cle, ecrire) {
      if (pression.bouton === null) {
        pression.ecritures.delete(cle);
        ecrire();
        return;
      }
      pression.ecritures.set(cle, ecrire);
    },
    /** Vrai si le rendu est RETENU jusqu'au relâchement : l'appelant ne rend pas maintenant. */
    differerLeRendu(rendre) {
      if (pression.bouton === null) return false;
      pression.rendu = rendre;
      return true;
    },
  });
}
