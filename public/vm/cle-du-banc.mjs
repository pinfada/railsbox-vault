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

let cle = null;

/**
 * Pose la clé du harnais pour la durée d'une exécution, et rend une fonction qui la relâche.
 *
 * @param {string | undefined} jeton le jeton que la page du banc transmet
 * @returns {() => void} à appeler dans un `finally`
 */
export function poserCleDuBanc(jeton) {
  cle = cleDeVolumeDuHarnais({ jeton });
  return () => {
    cle = null;
  };
}

/**
 * Rend la clé posée, ou refuse bruyamment.
 *
 * Bruyamment, et non par `null` : une phase qui recevrait `null` le passerait à `openOpfsVolume`,
 * qui refuserait par `VAULT_STORAGE_CLE_REQUISE` — un refus juste, mais qui accuserait le produit
 * là où c'est le banc qui a oublié de demander sa clé.
 */
export function cleDuBanc() {
  if (cle === null) {
    throw new Error(
      "Aucune clé de volume n'a été posée pour cette exécution : la page du banc doit transmettre le jeton du harnais (ADR 0016).",
    );
  }
  return cle;
}
