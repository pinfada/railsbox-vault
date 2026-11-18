// SQUELETTE NAÏF (#299) : tout est « version vérifiée ». Les épreuves rouges mesurent l'écart.
export const ETATS_DE_FRAICHEUR = Object.freeze({
  VERIFIEE: Object.freeze({ id: "version-verifiee", texte: "", effet: "autorise" }),
});
export function etatDeFraicheur() {
  return ETATS_DE_FRAICHEUR.VERIFIEE;
}
