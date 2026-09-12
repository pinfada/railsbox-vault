/** Conversions d'octets partagées par le banc et ses vérifications. Instrument de mesure, pas produit. */

/** @param {string} hex @returns {Uint8Array} */
export function depuisHex(hex) {
  if (hex.length % 2 !== 0) throw new Error(`hex de longueur impaire : ${hex.length}`);
  const octets = new Uint8Array(hex.length / 2);
  for (let i = 0; i < octets.length; i += 1)
    octets[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return octets;
}

/** @param {Uint8Array} octets @returns {string} */
export function versHex(octets) {
  let hex = "";
  for (const octet of octets) hex += octet.toString(16).padStart(2, "0");
  return hex;
}

/** @param {Uint8Array[]} morceaux @returns {Uint8Array} */
export function concatener(morceaux) {
  const total = morceaux.reduce((somme, morceau) => somme + morceau.length, 0);
  const sortie = new Uint8Array(total);
  let position = 0;
  for (const morceau of morceaux) {
    sortie.set(morceau, position);
    position += morceau.length;
  }
  return sortie;
}
