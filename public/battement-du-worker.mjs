// Le BATTEMENT du Worker de confiance pendant un geste LONG (#163, ADR 0030, décision 3 ; #192,
// correction I1).
//
// Il a quitté `runtime-worker.mjs` avec #207 : le Worker de confiance est à son plafond de lignes, et
// les trois gestes de portabilité y entraient. Rien n'a changé de ce qu'il fait — seulement où c'est
// écrit.

import { TYPES_PRIVILEGIES, enveloppeDeMessage } from "/src/coquille/contrat-de-messages.mjs";
import { DELAI_BATTEMENT_MS } from "/src/coquille/moyens-de-deverrouillage.mjs";

/**
 * Rend `enBattant(correlation, geste)` : exécute un geste LONG en battant, pour que la coquille sache
 * qu'il vit.
 *
 * Le battement n'est la réponse de personne — il porte la corrélation du geste, non pour l'apparier
 * mais pour dire QUELLE attente il prolonge. Il s'arrête dans un `finally` : un battement qui
 * survivrait à son geste ferait tenir pour vivante une attente déjà réglée.
 *
 * @param {{ poster: (message: object) => void,
 *           correlee: (correlation: string | null) => object }} liaison
 */
export function battementDuWorker({ poster, correlee }) {
  /**
   * Nombre de battements POSTÉS par ce Worker depuis son évaluation (#192, correction I1).
   *
   * Il voyage dans chaque battement, et la page en déduit ce qu'elle n'aurait pas su autrement :
   * un rang qui avance pendant qu'elle ne reçoit rien dit que le fil de la PAGE est affamé ; un rang
   * qui cesse d'avancer dit que le fil du WORKER l'est.
   */
  let battementsPostes = 0;

  /**
   * @param {string | null} correlation
   * @param {() => Promise<unknown>} geste
   */
  return async function enBattant(correlation, geste) {
    const minuterie = setInterval(() => {
      poster(
        enveloppeDeMessage(TYPES_PRIVILEGIES.battement, {
          ...correlee(correlation),
          // Le RANG et l'INSTANT du battement, posés par le Worker (#192, correction I1).
          //
          // Ils ne servent qu'à une chose, et elle est décisive : distinguer « le Worker n'a pas
          // battu » de « la page n'a pas reçu le battement ». Sans eux, la borne de mort par SILENCE
          // rend le même verdict dans les deux cas, et la cause reste une hypothèse. Ce sont deux
          // nombres du côté de confiance, qui ne disent rien du volume.
          rang: (battementsPostes += 1),
          instantMs: Math.round(performance.now()),
        }),
      );
    }, DELAI_BATTEMENT_MS);
    try {
      return await geste();
    } finally {
      clearInterval(minuterie);
    }
  };
}
