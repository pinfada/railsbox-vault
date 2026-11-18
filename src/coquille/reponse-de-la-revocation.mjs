// STUB NAÏF (commit rouge, #310) : tout succès, toute lecture « réussie ».
export function codeDeLErreur() {
  return null;
}
export function evenementDeLaReponse() {
  return "reponse-de-succes";
}
export function normaliserLInventaire() {
  return Object.freeze({
    ok: true,
    donnees: Object.freeze({
      public: Object.freeze({
        moyens: Object.freeze([]),
        nombreDeCodes: 0,
        parametres: Object.freeze([]),
      }),
      constat: null,
    }),
  });
}
