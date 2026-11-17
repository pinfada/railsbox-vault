/** Politique de CRÉATION uniquement : ne jamais modifier la phrase transmise au KDF. */
export const LONGUEUR_MINIMALE_PHRASE = 12;
export const CODE_PHRASE_FAIBLE = "VAULT_PHRASE_TROP_FAIBLE";

/** Le conseil qui accompagne tout constat : il ne change pas, la page peut l'écrire une fois (#266 B2-4). */
export const CONSEIL_DE_CHOIX_DE_PHRASE =
  "Choisissez plusieurs mots sans lien entre eux, ou un secret généré par votre gestionnaire de mots de passe.";

/** Le constat varie avec la saisie ; le message entier reste celui que les refus et la relecture portent. */
const verdict = (admise, constat) => ({
  admise,
  constat,
  message: `${constat} ${CONSEIL_DE_CHOIX_DE_PHRASE}`,
});

/** Indication locale et prudente, sans prétendre mesurer l'entropie d'une phrase humaine. */
export function evaluerPhrase(phrase) {
  const texte = String(phrase ?? "");
  // Compte en POINTS DE CODE (`[...texte]` itère par point de code, pas en unités UTF-16) : c'est
  // la source de vérité de la politique. `interface-de-deverrouillage.mjs` pose l'attribut HTML
  // `minLength` au même seuil numérique, en UTF-16 — jamais plus restrictif que ce compte (voir son
  // commentaire), et jamais l'inverse : cette fonction seule gouverne la création.
  const longueur = [...texte.trim()].length;
  if (longueur < LONGUEUR_MINIMALE_PHRASE) {
    return verdict(
      false,
      `Au moins ${LONGUEUR_MINIMALE_PHRASE} caractères hors espaces de bord sont nécessaires.`,
    );
  }
  // Répétitions et suites évidentes : ce filtre ne remplace pas un dictionnaire d'attaque.
  const simple = texte.trim().toLowerCase();
  if (
    /^(.{1,4})\1+$/u.test(simple) ||
    /^(?:0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiop|azertyuiop)+$/u.test(simple)
  ) {
    return verdict(false, "Phrase trop prévisible : évitez les répétitions et les suites.");
  }
  return verdict(
    true,
    `Longueur suffisante (${longueur} caractères). La longueur seule ne garantit pas la robustesse.`,
  );
}

export function exigerPhraseDeCreation(phrase) {
  const verdict = evaluerPhrase(phrase);
  if (!verdict.admise)
    throw Object.assign(new Error(verdict.message), { code: CODE_PHRASE_FAIBLE });
}
