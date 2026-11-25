// L'ACQUIT de la révocation (#265 ; revue de #321, point 2) : ce que la page fait quand le Worker a acquitté la
// demande — le relevé de ce qui a été retiré, la fermeture du lien d'archive, la ligne d'état.
//
// Dans `src/` pour être mutée. La fermeture du lien est OBLIGATOIRE : l'archive que la page tient encore porte
// l'ancienne page de récupération, et la laisser offerte après une révocation ferait télécharger un fichier que
// la personne croit révoqué (revue de la PR #208, constat 4). Sans cette fonction, rien ne se construit.

/**
 * @param {{ rapport: object, publier: () => void, retirerLeLien: () => void,
 *           noeudDeLigne: { textContent: string } }} liaison
 * @returns {(rendu: object) => void}
 */
export function creerLAcquit({ rapport, publier, retirerLeLien, noeudDeLigne }) {
  if (typeof retirerLeLien !== "function") {
    throw new TypeError("« retirerLeLien » est obligatoire : la fermeture du lien d'archive.");
  }
  return (rendu) => {
    rapport.portabilite ??= { sauvegarde: null, restauration: null, revocation: null };
    rapport.portabilite.revocation = {
      versionEnveloppe: rendu.versionEnveloppe,
      restants: rendu.restants,
      retires: rendu.retires,
      nombreRetires: rendu.nombreRetires,
      nombreRestants: rendu.nombreRestants,
      copieDeSauvegardeRetiree: rendu.copieDeSauvegardeRetiree,
    };
    retirerLeLien();
    // Le relevé est PUBLIÉ avant que la ligne d'état le dise (revue de la PR #208, constat 7).
    publier();
    noeudDeLigne.textContent = `portabilite:revoque:${rendu.nombreRetires}-retires:${rendu.nombreRestants}-restant`;
  };
}
