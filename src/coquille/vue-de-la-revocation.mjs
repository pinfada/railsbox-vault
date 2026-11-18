// STUB NAÏF (commit rouge, #310) : la vue est vide, l'empreinte constante, les portes ouvertes.
export function vueDe() {
  return Object.freeze({});
}
export function canonique() {
  return "";
}
export function empreinteDeLEtat() {
  return "";
}
export function affirmationsDe() {
  return Object.freeze({ revoque: true, peutEtreRevoque: false, aucunGesteDansCetteSeance: true });
}
export function connuDe() {
  return Object.freeze({ public: true, constat: true });
}
export function lirePublic(etat) {
  return etat.donnees?.public ?? {};
}
export function lireLeConstat(etat) {
  return etat.donnees?.constat ?? {};
}
