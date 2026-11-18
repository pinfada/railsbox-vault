// La PROJECTION d'un état vers ce que C2 consomme : affirmations, écran imposé, région, gestes, vue
// et empreinte (#310, ADR 0049). Fonction PURE de l'état seul (I7, I8).

import { EVENEMENTS_DE_GESTE, transiter } from "./modele-de-la-revocation.mjs";
import { affirmationsDe, connuDe, empreinteDeLEtat, vueDe } from "./vue-de-la-revocation.mjs";

/** Les gestes ouverts, et pourquoi les autres sont fermés : UN SEUL calcul, celui de la table. */
function gestesDe(etat) {
  const gestes = {};
  for (const type of EVENEMENTS_DE_GESTE) {
    const resultat = transiter(etat, { type });
    gestes[type] = Object.freeze({
      ouvert: resultat.accepte,
      raison: resultat.accepte ? null : resultat.annonce,
    });
  }
  return Object.freeze(gestes);
}

/**
 * @param {object} etat un état valide
 * @returns {{ affirmations: object, connu: object, ecranImpose: string | null,
 *             region: string | null, finDisponible: string | null, gestes: object,
 *             vue: object, empreinte: string }}
 */
export function projeter(etat) {
  const vue = vueDe(etat);
  return Object.freeze({
    affirmations: affirmationsDe(etat),
    connu: connuDe(etat),
    ecranImpose: vue.ecranImpose,
    region: vue.region,
    finDisponible: vue.finDisponible,
    gestes: gestesDe(etat),
    vue,
    empreinte: empreinteDeLEtat(etat),
  });
}
