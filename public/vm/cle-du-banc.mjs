// Clé de volume des BANCS, tenue le temps d'une exécution (#18, ADR 0016, décision 6).
//
// Le format v3 est chiffré : aucun volume ne s'ouvre sans clé. Le produit n'en fabrique aucune avant
// #21, et les bancs reçoivent celle du HARNAIS, sous jeton — la même garde que l'injecteur d'arrêts
// de #15 (`crash-harness.mjs`), pour la même raison : elle interdit l'usage ACCIDENTEL et rend
// l'intention explicite ; elle ne prétend pas résister à un appelant décidé qui vit déjà dans le
// Worker.
//
// Ce module ne vit que dans `public/vm/`, c'est-à-dire dans les BANCS. Aucun module de `src/` ne
// l'importe, et c'est ce qui rend vraie la phrase « aucun chemin du produit ne transmet le jeton » :
// la seule façon d'obtenir une clé ici est de recevoir le jeton d'une page de banc, qui le nomme.
//
// La clé est POSÉE à l'entrée d'une exécution et RELÂCHÉE à sa sortie. Un banc qui la garderait
// d'une phase à l'autre ferait passer pour acquis ce qui doit être redemandé, et une phase qui
// aurait oublié de la demander tomberait sur une clé fantôme au lieu d'un refus.

import { cleDeVolumeDuHarnais } from "/src/vm/cle-de-volume.mjs";

let jetonCourant = null;

/**
 * Retient le jeton d'une exécution, et rend la fonction qui l'oublie.
 *
 * C'est le JETON qui est retenu, pas la clé, et la nuance décide de l'ordre des refus. Un scénario
 * peut échouer AVANT d'ouvrir le moindre volume — un contexte incapable d'exécuter le runtime est
 * refusé par `VAULT_RUNTIME_WORKER_REFUSED` (#52), et cette raison-là est la bonne. Fabriquer la
 * clé à l'entrée du Worker ferait passer un jeton manquant avant ce refus, et le banc accuserait la
 * clé d'un défaut qui est celui du contexte.
 *
 * @param {string | undefined} jeton le jeton que la page du banc transmet
 * @returns {() => void} à appeler dans un `finally`
 */
export function poserCleDuBanc(jeton) {
  jetonCourant = jeton;
  return () => {
    jetonCourant = null;
  };
}

/**
 * Clé de volume DÉVELOPPÉE d'une enveloppe (#21, ADR 0020), tenue pour la durée d'une phase.
 *
 * Elle existe pour que le scénario de bout en bout puisse booter Rails sur un volume ouvert PAR UNE
 * CLÉ DE DÉVERROUILLAGE, et non par le jeton du harnais. Sans elle, l'épreuve de bout en bout ne
 * mesurerait que la même chose qu'avant #21 — un volume ouvert sous une clé remise en clair — et la
 * rotation de KEK ne serait démontrée nulle part au niveau où elle compte.
 *
 * Elle est POSÉE et RELÂCHÉE comme le jeton, et pour la même raison : une clé qui traverserait les
 * phases ferait passer pour acquis ce qui doit être redemandé à chaque ouverture.
 */
let cleDeveloppee = null;

/**
 * Installe la clé de volume développée d'une enveloppe, et rend la fonction qui l'oublie ET qui
 * EFFACE le tampon. L'effacement n'est pas une garantie — un moteur peut avoir copié le tampon —,
 * c'est une fenêtre refermée, et elle est gratuite.
 *
 * @param {Uint8Array} dek
 * @returns {() => void} à appeler dans un `finally`
 */
export function poserCleDeveloppee(dek) {
  cleDeveloppee = dek;
  return () => {
    if (cleDeveloppee instanceof Uint8Array) cleDeveloppee.fill(0);
    cleDeveloppee = null;
  };
}

/**
 * Rend la clé de volume à employer : celle DÉVELOPPÉE d'une enveloppe si une phase en a posé une,
 * sinon celle du harnais — ou un refus bruyant, au point d'usage.
 *
 * L'ordre n'est pas indifférent. Une phase qui a ouvert une enveloppe a une clé ÉTABLIE ; lui
 * préférer celle du harnais ouvrirait le volume sous un secret que tout le monde connaît, et
 * l'épreuve passerait quand même — c'est-à-dire ne mesurerait plus rien.
 */
export function cleDuBanc() {
  if (cleDeveloppee !== null) return cleDeveloppee;
  return cleDeVolumeDuHarnais({ jeton: jetonCourant });
}
