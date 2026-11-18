// SQUELETTE NAÏF du générateur de la réserve (#299) : il ne liste rien. Les épreuves rouges de la
// tranche mesurent l'écart entre cet état et la décision de l'ADR 0048.
export const CHEMIN_DU_SW = "/sw-coquille.mjs";
export const CHEMIN_DU_MODULE_DE_PAGE = "/coquille/reserve-publiee.mjs";
export const PREFIXE_DE_CACHE = "reserve-";
export const EXCLUS_DE_LA_RESERVE = Object.freeze([]);
export const PASSAGE_NOMME = Object.freeze([]);

export function classerLesChemins() {
  return { reserve: [], exclus: [], passage: [], inconnus: [] };
}
export function fabriquerLaReserve() {
  return {
    liste: {},
    alias: {},
    profils: [],
    identite: "",
    config: {},
    script: "",
    moduleDePage: "",
  };
}
export function fabriquerLeScriptDeRetrait() {
  return "";
}
export async function produireLaReserve() {
  return { identite: "", entrees: 0, taille: 0, sequence: 0 };
}
