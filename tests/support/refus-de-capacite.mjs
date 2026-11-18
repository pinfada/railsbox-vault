// Les codes par lesquels un moteur REFUSE d'ouvrir un volume, côté épreuves de frontière.
//
// Sous WebKit 26.5 la fonction `navigator.storage.getDirectory` manquait : le refus était
// `VAULT_STORAGE_UNSUPPORTED`, une absence. Sous WebKit ≥ 26.6 elle existe et REJETTE `UnknownError`
// en contexte éphémère, rejet que le moteur dit « transitoire » : le refus est
// `VAULT_STORAGE_INDETERMINE` — inaccessible pour l'instant, cause non établie, réessayable —, qui
// n'affirme AUCUNE absence (#231). Les épreuves « le moteur le refuse typé » acceptent ces deux codes,
// et ceux-là seulement : un autre code, ou un plantage non typé, les ferait échouer.
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

export const CODES_DE_REFUS_DE_CAPACITE = Object.freeze([
  STORAGE_ERROR_CODES.unsupported,
  STORAGE_ERROR_CODES.indeterminate,
]);

/** Pour `toContainText` : l'un ou l'autre des deux codes. */
export const MOTIF_DE_REFUS_DE_CAPACITE = new RegExp(CODES_DE_REFUS_DE_CAPACITE.join("|"));

/**
 * Les états d'un volume qu'AUCUN geste ne peut ouvrir pour l'instant : `indisponible` (le moteur ne
 * sait pas) et `indetermine` (le stockage ne répond pas, cause non établie, réessayable). Sous WebKit
 * ≥ 26.6 en contexte éphémère c'est le second (#231).
 */
export const ETATS_SANS_VOLUME = Object.freeze([
  ETATS_DU_VOLUME.indisponible,
  ETATS_DU_VOLUME.indetermine,
]);
