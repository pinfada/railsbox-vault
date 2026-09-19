// La PHASE d'un démarrage, telle que le Worker de confiance la connaît (recette QA de la PR #249, Q2 ;
// contre-recette, défaut 1).
//
// Une mise à jour dure trois à quatre minutes ; la personne qui attend doit savoir OÙ elle en est, et
// la recette n'a pas pu viser une coupure en pleine migration faute de le voir. Les trois phases sont
// tirées de signaux du Worker et du guest : l'acquisition du runtime (téléchargement), le crochet posé
// après elle (démarrage), et la ligne `[schema] migration commencee` que le guest imprime AVANT de
// charger Rails pour `db:migrate` (mise à jour des données), refermée par `[schema] migration jouee`.
// Aucune durée n'est estimée ici.
//
// La phase « données » n'est acceptée que si le Worker a AUTORISÉ la migration de ce boot (le geste
// « Mettre à jour », `vault.migrer=1`) : une ligne forgée sur la série hors d'une mise à jour — par
// l'application elle-même, par exemple — ne l'affiche pas. Une fois la migration jouée, l'autorisation
// tombe : la phase ne se rouvre pas.
//
// Ce module ne tient que deux VALEURS, dans le fil du Worker : le battement lit la phase et la porte à
// la page. Il appartient à `src/vm/`, qui ne connaît pas la coquille — le veilleur de schéma y écrit.

/** Les phases d'un démarrage. Une autre valeur n'est jamais posée. */
export const PHASES_DU_BOOT = Object.freeze({
  telechargement: "telechargement",
  demarrage: "demarrage",
  donnees: "donnees",
});

const CONNUES = new Set(Object.values(PHASES_DU_BOOT));

let phaseCourante = null;
let donneesAutorisees = false;

/**
 * POSE la phase courante. `null` l'efface et retire l'autorisation (début et fin d'un geste) ; une
 * valeur inconnue l'efface ; « données » sans autorisation est ignorée.
 *
 * @param {string | null} phase
 */
export function poserLaPhase(phase) {
  if (phase === PHASES_DU_BOOT.donnees && !donneesAutorisees) return;
  if (phase === null) donneesAutorisees = false;
  phaseCourante = CONNUES.has(phase) ? phase : null;
}

/** AUTORISE, ou non, la phase « données » pour le boot qui commence : seulement sous le geste. */
export function autoriserLaPhaseDesDonnees(autorisee) {
  donneesAutorisees = autorisee === true;
}

/** La phase courante, ou `null` hors d'un démarrage. */
export function phaseDuBoot() {
  return phaseCourante;
}

/**
 * La phase qu'une ligne de la série du guest fait commencer, ou `null` si elle n'en change pas.
 *
 * @param {string} ligne
 */
export function phaseDeLaLigne(ligne) {
  if (ligne.startsWith("[schema] migration commencee ")) return PHASES_DU_BOOT.donnees;
  if (ligne.startsWith("[schema] migration jouee ")) return PHASES_DU_BOOT.demarrage;
  return null;
}

/**
 * APPLIQUE une ligne de la série : pose la phase qu'elle ouvre ; la fin de la migration retire
 * l'autorisation, pour qu'aucune ligne suivante ne rouvre « données ».
 *
 * @param {string} ligne
 */
export function appliquerLaLigne(ligne) {
  const phase = phaseDeLaLigne(ligne);
  if (phase === null) return;
  poserLaPhase(phase);
  if (phase === PHASES_DU_BOOT.demarrage) donneesAutorisees = false;
}
