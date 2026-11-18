// Les codes et les états par lesquels un moteur REFUSE d'ouvrir un volume, côté épreuves de frontière.
//
// Sous WebKit 26.5 la fonction `navigator.storage.getDirectory` manquait : le refus était
// `VAULT_STORAGE_UNSUPPORTED`, une absence. Sous WebKit ≥ 26.6 elle existe et REJETTE `UnknownError` en
// contexte éphémère, rejet que le moteur dit « transitoire » : le refus est `VAULT_STORAGE_INDETERMINE`
// — inaccessible pour l'instant, cause non établie, réessayable — et l'état `indetermine` (#231).
//
// **Le moteur est celui de la FIXTURE, jamais ce que la page affiche** (revue complète de la PR #305) :
// seul WebKit, dont le contexte `page` est éphémère, admet `INDETERMINE` et `indetermine`. Sur Chromium et
// Firefox, ces valeurs ne sont PAS acceptées : l'épreuve échoue, comme avant ce lot.
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

/** Le moteur du contexte de la page : `"chromium"`, `"firefox"` ou `"webkit"`. */
export const moteurDe = (page) => page.context().browser()?.browserType().name() ?? null;

const estWebkit = (page) => moteurDe(page) === "webkit";

/** Les codes d'un refus de capacité que ce moteur peut rendre. */
export const codesDeRefusDeCapacite = (page) =>
  estWebkit(page)
    ? [STORAGE_ERROR_CODES.unsupported, STORAGE_ERROR_CODES.indeterminate]
    : [STORAGE_ERROR_CODES.unsupported];

/** Pour `toContainText` : l'un ou l'autre des codes admis par ce moteur. */
export const motifDeRefusDeCapacite = (page) => new RegExp(codesDeRefusDeCapacite(page).join("|"));

/** Les états d'un volume qu'AUCUN geste ne peut ouvrir pour l'instant, pour ce moteur. */
export const etatsSansVolume = (page) =>
  estWebkit(page)
    ? [ETATS_DU_VOLUME.indisponible, ETATS_DU_VOLUME.indetermine]
    : [ETATS_DU_VOLUME.indisponible];
