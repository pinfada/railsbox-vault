// La BARRE DU COFFRE du parcours (ADR 0043, R1-bis), extraite de `parcours-de-la-page.mjs` (#265) quand
// ce fichier a atteint le plafond de taille. Aucun changement de comportement : mêmes boutons, mêmes
// largeurs, mêmes attributs.

/**
 * La BARRE DU COFFRE (ADR 0043, R1-bis) : quand l'application tourne, « Sauvegarder »,
 * « Verrouiller » et « Continuer » sont DÉPLACÉS dans la barre, dans son ordre visuel, puis rendus
 * à leur place d'origine. Ce sont les mêmes boutons, mêmes identifiants ; seul le cadre de
 * l'application est intouchable (le déplacer le rechargerait). Un geste dont le bloc d'étape est
 * caché reste caché dans la barre (`data-hors-etape`), sauf Sauvegarder et Verrouiller, toujours
 * offerts tant que l'application tourne.
 */
/**
 * @param {{ doc: Document, noeud: (id: string) => HTMLElement | null }} hote
 * @returns {(dansLaBarre: boolean) => void} `placerLesGestes`
 */
export function creerLaBarreDuCoffre({ doc, noeud }) {
  const GESTES_DE_LA_BARRE = [
    "sauvegarder-le-coffre",
    "verrouiller-le-coffre",
    "parcours-continuer",
  ];
  // La barre est RESPONSIVE : un geste n'y monte que si la largeur le permet ; sinon il reste à sa
  // place, dans le panneau du menu « Coffre », où il demeure joignable (ADR 0043). Sous 640 px, la
  // barre ne porte que le titre et « Coffre ».
  const LARGEUR_MIN_DANS_LA_BARRE = Object.freeze({
    "sauvegarder-le-coffre": 640,
    "verrouiller-le-coffre": 640,
    "parcours-continuer": 900,
  });
  const fenetre = doc.defaultView ?? null;
  const assezLarge = (id) =>
    typeof fenetre?.matchMedia !== "function" ||
    fenetre.matchMedia(`(min-width: ${LARGEUR_MIN_DANS_LA_BARRE[id]}px)`).matches;
  let barreDemandee = false;
  for (const largeur of new Set(Object.values(LARGEUR_MIN_DANS_LA_BARRE))) {
    fenetre
      ?.matchMedia?.(`(min-width: ${largeur}px)`)
      ?.addEventListener?.("change", () => placerLesGestes(barreDemandee));
  }
  const placesDOrigine = new Map();
  function placerLesGestes(dansLaBarre) {
    barreDemandee = dansLaBarre;
    const barre = noeud("gestes-de-la-barre");
    if (!barre) return;
    const panneau = noeud("gestes-du-panneau") ?? barre;
    for (const id of GESTES_DE_LA_BARRE) {
      const bouton = noeud(id);
      // Application démarrée : dans la barre si la largeur le permet, sinon en tête du panneau.
      // Application arrêtée : à sa place d'origine, dans son étape.
      const cible = !dansLaBarre ? null : assezLarge(id) ? barre : panneau;
      if (cible && bouton.parentElement !== cible) {
        if (!placesDOrigine.has(id)) {
          const repere = doc.createComment(id);
          bouton.before(repere);
          placesDOrigine.set(id, repere);
        }
        cible.append(bouton);
      } else if (!cible && placesDOrigine.has(id)) {
        placesDOrigine.get(id).replaceWith(bouton);
        placesDOrigine.delete(id);
      }
      const repere = placesDOrigine.get(id);
      const horsEtape =
        id === "parcours-continuer" && repere?.parentElement?.closest("[hidden]") != null;
      bouton.toggleAttribute("data-hors-etape", horsEtape);
    }
    const cadre = noeud("cadre-applicatif");
    if (dansLaBarre) cadre.tabIndex = -1;
    const evitement = noeud("lien-d-evitement");
    if (!evitement) return;
    evitement.setAttribute("href", dansLaBarre ? "#cadre-applicatif" : "#parcours-titre");
    evitement.textContent = dansLaBarre ? "Aller à l'application" : "Aller au parcours";
  }
  return placerLesGestes;
}
