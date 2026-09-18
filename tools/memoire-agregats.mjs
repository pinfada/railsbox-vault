// AGRÉGATS du banc mémoire : le pic d'une phase, et ce qui est vrai AU pic (#236, revue de sécurité).
//
// Extrait de `mesurer-memoire.mjs` pour une raison précise : c'est un calcul, il décidait d'un
// chiffre publié dans `docs/quality-attributes.md` et dans une issue, et rien ne le mesurait.
//
// ## Ce que « au pic » veut dire, et ce qu'il ne veut pas dire
//
// Une phase est une SÉRIE de relevés. Le pic est le plus grand résident de la série. Tout ce qui est
// publié « au pic » doit venir de CET échantillon-là : le privé, le plus gros processus. Un
// `Math.max` indépendant sur la série du privé rend un nombre qui n'a jamais coexisté avec le pic —
// et il rendait ici 1 843 Mio à côté d'un pic de 1 552 Mio, c'est-à-dire un privé plus grand que le
// résident dont il est une part.
//
// Le maximum du privé reste publié, mais sous son propre nom (`priveMaximumOctets`) : il dit autre
// chose — la plus grande empreinte privée atteinte pendant la phase —, et ce n'est pas au lecteur de
// deviner lequel des deux il lit.

/**
 * @typedef {{ residentOctets: number, priveOctets: number | null,
 *             plusGrosProcessus: string | null, processus: number }} Releve
 */

/**
 * @param {Releve[]} releves
 * @returns {{ releves: number, residentPicOctets: number, residentMoyenOctets: number,
 *             priveAuPicOctets: number | null, priveMaximumOctets: number | null,
 *             plusGrosProcessusAuPic: string | null, processusMax: number } | null}
 */
export function agregerLesReleves(releves) {
  if (!Array.isArray(releves) || releves.length === 0) return null;

  const residents = releves.map((releve) => releve.residentOctets);
  const pic = Math.max(...residents);
  // L'ÉCHANTILLON du pic, et non la série : c'est lui qui porte tout ce qui est publié « au pic ».
  const auPic = releves.find((releve) => releve.residentOctets === pic);
  const prives = releves.map((releve) => releve.priveOctets).filter((valeur) => valeur !== null);
  const priveConnuPartout = prives.length === releves.length;

  return {
    releves: releves.length,
    residentPicOctets: pic,
    residentMoyenOctets: Math.round(residents.reduce((a, b) => a + b, 0) / residents.length),
    priveAuPicOctets: priveConnuPartout ? (auPic?.priveOctets ?? null) : null,
    priveMaximumOctets: priveConnuPartout ? Math.max(...prives) : null,
    plusGrosProcessusAuPic: auPic?.plusGrosProcessus ?? null,
    processusMax: Math.max(...releves.map((releve) => releve.processus)),
  };
}
