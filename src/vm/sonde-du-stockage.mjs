// ROUGE : la sémantique actuelle — un seul essai, tout `UnknownError` vaut « absente » — que les
// épreuves du lot rejettent. Le code vert remplace ce fichier.

export const VERDICTS_DU_STOCKAGE = Object.freeze({
  atteignable: "atteignable",
  absente: "absente",
  indetermine: "indetermine",
  panne: "panne",
});

export const ESSAIS_DE_LA_SONDE = 3;
export const DELAI_ENTRE_ESSAIS_MS = 100;

export function classerLeRejetDeRacine(cause) {
  return cause?.name === "UnknownError" ? "absente" : "panne";
}

export async function sonderLeStockage({ storage = globalThis.navigator?.storage } = {}) {
  if (typeof storage?.getDirectory !== "function") return VERDICTS_DU_STOCKAGE.absente;
  try {
    await storage.getDirectory();
    return VERDICTS_DU_STOCKAGE.atteignable;
  } catch (cause) {
    return classerLeRejetDeRacine(cause);
  }
}
