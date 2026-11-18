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
 * `moyens` ne porte que des TYPES, dédoublonnés : il ne dit pas combien de feuilles existent. Or le
 * Worker retire tout emplacement sauf celui de la séance (ADR 0026) — l'AUTRE feuille d'un coffre qui
 * en porte deux, quand la séance est ouverte par l'une. `codes`, le compte que la page connaît déjà,
 * le dit : sans lui, la phrase « rien ne sera retiré » serait fausse (relecture de #308). Aucune liste
 * exacte n'est promise : « vos autres codes » dit qu'ils partent, pas lesquels.
 *
 * @param {string} moyen
 * @param {readonly string[] | null} moyens
 * @param {{ codes?: number | null }} [options]
 */
export function lesAutresRetires(moyen, moyens, { codes = null } = {}) {
  const presents = Array.isArray(moyens) ? moyens : Object.keys(AUTRE_NOMME);
  const autres = presents.filter((m) => m !== moyen && AUTRE_NOMME[m] !== undefined);
  const autresFeuilles = moyen === "recuperation" && typeof codes === "number" && codes > 1;
  const noms = autres.map((m) => AUTRE_NOMME[m]);
  if (autresFeuilles) noms.push("vos autres codes de récupération");
  if (noms.length === 0) return "Aucun autre moyen n'ouvre ce coffre : rien ne sera retiré.";
  const liste =
    noms.length === 1 ? noms[0] : `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;
  const sujet = liste.charAt(0).toUpperCase() + liste.slice(1);
  const verbe =
    noms.length === 1 && autres[0] !== "recuperation" && !autresFeuilles
      ? "ne fonctionnera"
      : "ne fonctionneront";
  const feuille = autres.includes("recuperation")
    ? " : votre feuille de récupération ne servira plus à rien, créez-en une nouvelle ensuite."
    : moyen === "recuperation"
      ? autresFeuilles
        ? " sur ce coffre : seul le code avec lequel vous venez de l'ouvrir l'ouvrira."
        : " sur ce coffre : seul le code de votre feuille l'ouvrira."
      : ".";
  return `${sujet} ${verbe} plus${feuille}`;
}
