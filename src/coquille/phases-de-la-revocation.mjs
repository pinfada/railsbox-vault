// STUB NAÏF (commit rouge, #310) : même API, comportement volontairement faux.
export const PHASES = Object.freeze(
  Object.fromEntries(
    ["F0", "FL", "FC", "FE", "FM", "SL", "SE", "SM", "RL", "RE", "RM", "P", "C", "V", "K", "I"].map(
      (p) => [p, p],
    ),
  ),
);
export const LISTE_DES_PHASES = Object.freeze(Object.values(PHASES));
export const PHASES_CONNUES = Object.freeze(new Set());
export const PHASES_EN_LECTURE = Object.freeze(new Set());
export const PHASES_APRES_ENVOI = Object.freeze(new Set());
export const PHASES_APRES_SUCCES = Object.freeze(new Set());
export const PHASES_FERMEES = Object.freeze(new Set());
export const SESSION_VIDE = Object.freeze({ moyen: null });
export function creerEtat(champs) {
  return Object.freeze({
    lecture: null,
    sequence: 0,
    donnees: null,
    session: SESSION_VIDE,
    occurrence: 0,
    ...champs,
  });
}
export function etatInitial(indice) {
  return creerEtat({ phase: "P", indice });
}
export function exigerUnEtat(etat) {
  return etat;
}
