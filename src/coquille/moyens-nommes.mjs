// Les moyens d'ouvrir un coffre, tels qu'une personne les nomme, et ce que la révocation retire des
// autres. Extraits de `textes-du-parcours.mjs` (#266 Q3) : les textes ne nomment que les moyens
// RÉELLEMENT présents.

/** Le moyen avec lequel la personne vient d'ouvrir le coffre. */
export const MOYEN_NOMME = Object.freeze({
  phrase: "votre phrase",
  "webauthn-prf": "votre passkey",
  recuperation: "le code de votre feuille",
});

/** Les autres moyens, ceux que la révocation retirerait. */
const AUTRE_NOMME = Object.freeze({
  phrase: "votre phrase",
  "webauthn-prf": "votre passkey",
  recuperation: "vos codes de récupération",
});

/**
 * Ce que la révocation retire : un coffre sans passkey n'entend jamais parler de passkey. `moyens`
 * inconnu : tous les moyens possibles.
 *
 * @param {string} moyen
 * @param {readonly string[] | null} moyens
 */
export function lesAutresRetires(moyen, moyens) {
  const presents = Array.isArray(moyens) ? moyens : Object.keys(AUTRE_NOMME);
  const autres = presents.filter((m) => m !== moyen && AUTRE_NOMME[m] !== undefined);
  if (autres.length === 0) return "Aucun autre moyen n'ouvre ce coffre : rien ne sera retiré.";
  const noms = autres.map((m) => AUTRE_NOMME[m]);
  const liste =
    noms.length === 1 ? noms[0] : `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;
  const sujet = liste.charAt(0).toUpperCase() + liste.slice(1);
  const verbe =
    noms.length === 1 && autres[0] !== "recuperation" ? "ne fonctionnera" : "ne fonctionneront";
  const feuille = autres.includes("recuperation")
    ? " : votre feuille de récupération ne servira plus à rien, créez-en une nouvelle ensuite."
    : moyen === "recuperation"
      ? " sur ce coffre : seul le code de votre feuille l'ouvrira."
      : ".";
  return `${sujet} ${verbe} plus${feuille}`;
}
