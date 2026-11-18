// STUB NAÏF (commit rouge, #310) : tout est accepté, l'état ne bouge jamais, aucun effet.
export const LANCEURS_D_ENVELOPPE = Object.freeze([]);
export const EVENEMENTS = Object.freeze([
  "montage",
  "coffre-ouvert",
  "demander-la-revocation",
  "oui",
  "annuler",
  "reponse-de-succes",
  "refus-type",
  "worker-mort",
  "worker-rompu",
  "reponse-malformee",
  "erreur-sans-code",
  "delai-depasse",
  "relecture-reussie",
  "relecture-echouee",
  "verrouiller",
  "changer-d-etape",
  "terminer-sans-revoquer",
  "revenir-a-l-application",
  "modification-lancee",
  "modification-terminee",
  "indice-change",
  "masquage-impossible",
]);
export const EVENEMENTS_DE_GESTE = Object.freeze([
  "demander-la-revocation",
  "oui",
  "annuler",
  "verrouiller",
  "terminer-sans-revoquer",
  "revenir-a-l-application",
  "modification-lancee",
]);
export function transiter(etat) {
  return Object.freeze({ accepte: true, etat, effets: Object.freeze([]), annonce: null });
}
export function accepte() {
  return true;
}
