// La FABRIQUE d'un écran du parcours (#193) : une forme gelée, la même pour tous les écrans. Extraite de
// `textes-du-parcours.mjs` (#265) quand ce fichier a atteint le seuil d'alerte de taille.

/** @param {number | null} rang */
export function ecran(
  rang,
  { titre, ceQuiVaSePasser, attendu, casRares = null, attente = null, blocs },
) {
  return Object.freeze({
    etape: rang,
    titre,
    ceQuiVaSePasser,
    attendu,
    // Les cas rares, repliés sous « Je n'ai plus ma feuille » (R1-bis, point 6).
    casRares,
    attente,
    blocs: Object.freeze([...blocs]),
  });
}
