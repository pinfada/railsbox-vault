// LA SONDE DU STOCKAGE (#231, revues de la PR #305) : l'OPFS est-elle atteignable, absente, ou
// INDÉTERMINÉE ?
//
// Depuis WebKit 26.6, `navigator.storage.getDirectory` est une fonction, et son appel REJETTE
// `UnknownError` dans un contexte éphémère — mesuré sous Playwright 1.63.0 (WebKit 26.6), 1.64.0 et
// 1.65.0 (WebKit 27.2). Le message du moteur est « The operation failed for an unknown transient
// reason (e.g. out of memory). » : il parle d'une raison TRANSITOIRE. Un tel rejet ne prouve donc PAS
// que l'OPFS est absente, et le produit ne l'affirme pas :
//
//  - la sonde RÉESSAIE un nombre borné de fois, avec un court délai (`ESSAIS_DE_LA_SONDE`,
//    `DELAI_ENTRE_ESSAIS_MS`). Mesuré le 18/11/2026 sous WebKit 26.6 et 27.2 en contexte éphémère : le
//    rejet est immédiat (0 à 1 ms) et constant (8 essais sur 8, étalés sur 800 ms) ; le coût de la
//    sonde, dans ce cas, est donc le seul délai : (essais − 1) × 100 ms, soit 200 ms au démarrage ;
//  - si le rejet PERSISTE, le verdict est `indetermine` — « le stockage du navigateur est inaccessible
//    pour l'instant, cause non établie » — et non `absente` ;
//  - rien n'est figé : l'appelant peut sonder de nouveau, et un succès lève l'indétermination.
//
// Seuls les refus de capacité que la table de `opfs-error-mapping.mjs` range DÉJÀ `unsupported`
// (`SecurityError`, `TypeMismatchError`) sont une absence ; tout autre rejet (quota, état invalide,
// erreur inconnue) est une `panne` : ni absence ni indétermination, un échec que le vrai geste signale
// avec son code précis.

import { toStorageError } from "./opfs-error-mapping.mjs";
import { STORAGE_ERROR_CODES } from "./storage-errors.mjs";

export const VERDICTS_DU_STOCKAGE = Object.freeze({
  /** `getDirectory()` aboutit. */
  atteignable: "atteignable",
  /** Capacité ABSENTE : la fonction manque, ou un refus de capacité déjà typé. Durable, dit tel. */
  absente: "absente",
  /** Le rejet que le moteur dit transitoire a persisté : inaccessible pour l'instant, cause non établie. */
  indetermine: "indetermine",
  /** Tout autre rejet : un échec, qui n'est pas une indisponibilité. */
  panne: "panne",
});

/** Le nom du seul rejet que le dépôt a mesuré comme « transitoire » : `UnknownError`. */
export const REJET_TRANSITOIRE_MESURE = "UnknownError";

/** Nombre d'appels de `getDirectory()` par sonde, le premier compris. Borné. */
export const ESSAIS_DE_LA_SONDE = 3;

/** Délai entre deux essais. Pas de délai après le dernier. */
export const DELAI_ENTRE_ESSAIS_MS = 100;

/**
 * Classe le rejet de `getDirectory()` : `absente`, `indetermine` ou `panne`.
 *
 * @param {unknown} cause
 * @returns {"absente" | "indetermine" | "panne"}
 */
export function classerLeRejetDeRacine(cause) {
  if (cause?.name === REJET_TRANSITOIRE_MESURE) return VERDICTS_DU_STOCKAGE.indetermine;
  // `SecurityError` et `TypeMismatchError` : refus de capacité déjà rangés `unsupported`.
  const code = toStorageError(cause, { operation: "open-directory", volume: "-" }).code;
  return code === STORAGE_ERROR_CODES.unsupported
    ? VERDICTS_DU_STOCKAGE.absente
    : VERDICTS_DU_STOCKAGE.panne;
}

const attendreReel = (ms) => new Promise((fini) => setTimeout(fini, ms));

/**
 * Sonde le stockage. Ne lève jamais.
 *
 * @param {{ storage?: { getDirectory?: Function }, essais?: number, delaiMs?: number,
 *           attendre?: (ms: number) => Promise<unknown> }} [options]
 * @returns {Promise<"atteignable" | "absente" | "indetermine" | "panne">}
 */
export async function sonderLeStockage({
  storage = globalThis.navigator?.storage,
  essais = ESSAIS_DE_LA_SONDE,
  delaiMs = DELAI_ENTRE_ESSAIS_MS,
  attendre = attendreReel,
} = {}) {
  if (typeof storage?.getDirectory !== "function") return VERDICTS_DU_STOCKAGE.absente;
  for (let essai = 1; ; essai += 1) {
    try {
      await storage.getDirectory();
      return VERDICTS_DU_STOCKAGE.atteignable;
    } catch (cause) {
      const verdict = classerLeRejetDeRacine(cause);
      if (verdict !== VERDICTS_DU_STOCKAGE.indetermine || essai >= essais) return verdict;
    }
    await attendre(delaiMs);
  }
}
