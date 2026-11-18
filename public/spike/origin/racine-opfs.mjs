// LA RACINE DE L'OPFS pour les témoins de la frontière d'origine (#46, #231, revues de la PR #305).
//
// Quatre issues, et elles ne se confondent JAMAIS :
//
//  - la racine ;
//  - `indisponible` : l'API `getDirectory` est ABSENTE du moteur. Seule absence établie ;
//  - `indetermine` : `getDirectory()` a rejeté `UnknownError` — le rejet que WebKit 26.6+ oppose en
//    contexte éphémère et que le moteur dit lui-même « transitoire ». Il ne PROUVE aucune absence, et
//    il ne retire JAMAIS un témoin de la comparaison : il n'est toléré que par une épreuve qui connaît
//    son propre contexte (`tests/support/temoins-opfs.mjs`), jamais par ce nom d'erreur ;
//  - `panne` : tout AUTRE rejet. Une panne n'est ni une indisponibilité ni une `invisible` — dans une
//    topologie isolée, une sonde qui échoue passerait pour la PREUVE de l'isolation. `panne` n'est
//    attendue nulle part : l'épreuve échoue.
//
// Le module est servi aussi par l'origine APPLICATIVE : il n'importe rien de `src/`.

const NOM_DU_REJET_TRANSITOIRE = "UnknownError";

/**
 * @param {{ getDirectory?: Function }} [storage]
 * @returns {Promise<{ racine: object } | { absent: { resultat: string, detail: string } }>}
 */
export async function racineDeLOpfs(storage = globalThis.navigator?.storage) {
  if (!storage?.getDirectory) {
    return {
      absent: { resultat: "indisponible", detail: "navigator.storage.getDirectory absent" },
    };
  }
  try {
    return { racine: await storage.getDirectory() };
  } catch (erreur) {
    if (erreur?.name === NOM_DU_REJET_TRANSITOIRE) {
      return {
        absent: {
          resultat: "indetermine",
          detail: `navigator.storage.getDirectory rejeté (${NOM_DU_REJET_TRANSITOIRE})`,
        },
      };
    }
    return {
      absent: {
        resultat: "panne",
        detail: `${erreur?.name ?? "Error"}: ${erreur?.message ?? erreur}`,
      },
    };
  }
}

/**
 * Ce qu'une fouille de l'OPFS rend quand la racine manque (#231, revues de la PR #305). Une fouille qui
 * ne peut pas regarder n'est PAS une fouille vide : le rendu porte `impossible` — « indisponible » si
 * l'API manque, « indetermine » après un `UnknownError` — et c'est l'ÉPREUVE qui décide, de ce qu'elle
 * sait de son contexte, si c'est une panne ou une limite écrite. Une `panne` LÈVE : elle fait échouer
 * la fouille.
 *
 * @param {{ resultat: string, detail: string }} absent
 * @returns {{ texte: string, impossible: string }}
 */
export function fouilleImpossible(absent) {
  if (absent.resultat === "panne") throw new Error(absent.detail);
  return { texte: "", impossible: absent.resultat };
}
