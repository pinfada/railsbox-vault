// MESURES communes aux phases du Worker de référence (#7, #9, #11, #73).
//
// Elles ne décident de rien et ne bloquent rien : elles donnent aux rapports de quoi SITUER ce qui
// vient d'être fait — la place restante dans l'origine, la plus grande lecture émise. Un budget que
// personne ne mesure n'est pas tenu, il est supposé ; et « il n'y avait plus de place » cesse d'être
// une hypothèse quand un instantané le date.

import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";

/** Bloc de streaming de l'export/vérification E2E : 4 Mio, très en deçà du budget de surmémoire. */
export const EXPORT_BLOCK_BYTES = 4 * 1024 * 1024;

/**
 * INSTANTANÉ du budget de stockage de l'origine (#9), pris pour être PUBLIÉ (#73).
 *
 * Il ne décide de rien et ne bloque rien : il donne au rapport de quoi situer une écriture par
 * rapport au quota que le moteur accorde. Un moteur qui n'estime pas rend l'état `unknown` — une
 * inconnue, jamais une capacité nulle, exactement comme le pose `storage-budget.mjs`.
 */
export async function instantaneStockage() {
  const budget = createStorageBudget(bindNavigatorStorage(navigator.storage));
  const mesure = await budget.measure();
  return {
    state: mesure.state,
    quota: mesure.quota,
    usage: mesure.usage,
    available: mesure.available,
  };
}

/**
 * Enveloppe une source d'export pour COMPTER ses lectures. La plus grande lecture émise est la
 * preuve déterministe qu'un export à surmémoire bornée ne demande jamais tout le volume d'un coup :
 * elle est mesurée ici, pas déclarée ailleurs.
 */
export function sourceMesuree(base, compteur) {
  return {
    size: base.size,
    read(offset, length) {
      compteur.maxLecture = Math.max(compteur.maxLecture, length);
      compteur.blocs += 1;
      return base.read(offset, length);
    },
  };
}
