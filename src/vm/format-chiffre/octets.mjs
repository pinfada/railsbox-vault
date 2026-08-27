// Manipulation d'octets du modèle de référence (#17, ADR 0015).
//
// Ces fonctions n'ont aucune ambition cryptographique : elles servent à écrire des encodages
// DÉTERMINISTES et à comparer des octets sans passer par des chaînes intermédiaires ambiguës. Elles
// vivent ici plutôt que dans un module partagé parce que le format chiffré est une SPÉCIFICATION :
// tout ce dont il dépend doit pouvoir être relu en une fois par un relecteur externe (#20).
//
// `hexEnOctets` et `octetsEnHex` sont l'unique représentation textuelle admise dans les vecteurs :
// minuscules, sans séparateur, longueur paire. Un vecteur qui s'en écarterait serait refusé plutôt
// que réinterprété.

const HEX = /^[0-9a-f]*$/;

/** Encode des octets en hexadécimal minuscule, sans séparateur. */
export function octetsEnHex(octets) {
  if (!(octets instanceof Uint8Array)) {
    throw new TypeError(`Octets attendus, reçu ${Object.prototype.toString.call(octets)}.`);
  }
  let rendu = "";
  for (const octet of octets) rendu += octet.toString(16).padStart(2, "0");
  return rendu;
}

/** Relit une chaîne hexadécimale minuscule. Toute forme approchante est un refus, pas une tolérance. */
export function hexEnOctets(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !HEX.test(hex)) {
    throw new TypeError(`Chaîne hexadécimale minuscule de longueur paire attendue : ${hex}.`);
  }
  const octets = new Uint8Array(hex.length / 2);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}

/** Concatène des séquences d'octets dans l'ordre reçu. */
export function concatener(...morceaux) {
  const total = morceaux.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  const rendu = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of morceaux) {
    rendu.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return rendu;
}

/**
 * Comparaison d'octets à temps constant sur la LONGUEUR commune.
 *
 * Le modèle ne compare jamais une étiquette lui-même — c'est `crypto.subtle.decrypt` qui vérifie, et
 * l'implémentation du moteur qui répond de son temps. Cette fonction sert aux comparaisons
 * d'empreintes de la racine, où une fuite de temps apprendrait à un attaquant combien d'octets de
 * son empreinte forgée sont justes. La précaution est bon marché ; l'omettre demanderait une
 * justification, la prendre n'en demande pas.
 */
export function egalesEnTempsConstant(gauche, droite) {
  if (gauche.byteLength !== droite.byteLength) return false;
  let ecart = 0;
  for (let index = 0; index < gauche.byteLength; index += 1) ecart |= gauche[index] ^ droite[index];
  return ecart === 0;
}

/** Écrit un entier non signé sur `octets` octets, gros-boutiste. Refuse ce qui ne tient pas. */
export function entierEnOctets(valeur, octets) {
  if (!Number.isSafeInteger(valeur) || valeur < 0) {
    throw new RangeError(`Entier non négatif attendu : ${valeur}.`);
  }
  const rendu = new Uint8Array(octets);
  let reste = valeur;
  for (let index = octets - 1; index >= 0; index -= 1) {
    rendu[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  if (reste !== 0) {
    throw new RangeError(`${valeur} ne tient pas sur ${octets} octet(s).`);
  }
  return rendu;
}

/** Encode une chaîne UTF-8 précédée de sa longueur sur deux octets : aucune ambiguïté de frontière. */
export function chainePrefixee(valeur) {
  const utf8 = new TextEncoder().encode(valeur);
  if (utf8.byteLength > 0xffff) {
    throw new RangeError(`Chaîne trop longue pour un préfixe de deux octets : ${utf8.byteLength}.`);
  }
  return concatener(entierEnOctets(utf8.byteLength, 2), utf8);
}
