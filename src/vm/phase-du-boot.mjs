// La PHASE d'un démarrage, telle que le Worker de confiance la connaît (recette QA de la PR #249, Q2).
//
// Une mise à jour dure trois à quatre minutes ; la personne qui attend doit savoir OÙ elle en est, et
// la recette n'a pas pu viser une coupure en pleine migration faute de le voir. Les trois phases sont
// tirées de signaux qui EXISTAIENT déjà : l'acquisition du runtime (téléchargement), le crochet posé
// après elle (démarrage), et les lignes `[schema] rails` que le guest imprime pendant `db:migrate`
// (mise à jour des données). Aucun signal n'est inventé, aucune durée n'est estimée ici.
//
// Ce module ne tient qu'une VALEUR, dans le fil du Worker : le battement la lit et la porte à la page.
// Il appartient à `src/vm/`, qui ne connaît pas la coquille — le veilleur de schéma y écrit aussi.

/** Les phases d'un démarrage. Une autre valeur n'est jamais posée. */
export const PHASES_DU_BOOT = Object.freeze({
  telechargement: "telechargement",
  demarrage: "demarrage",
  donnees: "donnees",
});

const CONNUES = new Set(Object.values(PHASES_DU_BOOT));

let phaseCourante = null;

/**
 * POSE la phase courante ; une valeur inconnue, ou `null`, l'efface.
 *
 * @param {string | null} phase
 */
export function poserLaPhase(phase) {
  phaseCourante = CONNUES.has(phase) ? phase : null;
}

/** La phase courante, ou `null` hors d'un démarrage. */
export function phaseDuBoot() {
  return phaseCourante;
}

/**
 * La phase qu'une ligne de la série du guest fait commencer, ou `null` si elle n'en change pas : la
 * première ligne de Rails pendant `db:migrate` ouvre la mise à jour des données, la ligne « migration
 * jouee » la referme — Rails démarre ensuite.
 *
 * @param {string} ligne
 */
export function phaseDeLaLigne(ligne) {
  if (ligne.startsWith("[schema] rails : ")) return PHASES_DU_BOOT.donnees;
  if (ligne.startsWith("[schema] migration jouee ")) return PHASES_DU_BOOT.demarrage;
  return null;
}
