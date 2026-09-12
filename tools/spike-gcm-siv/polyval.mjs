/**
 * POLYVAL (RFC 8452, § 3) — instrument de MESURE du spike #185, pas du code de produit.
 *
 * Il n'existe que pour que le banc puisse exécuter un AES-GCM-SIV conforme SANS dépendance tierce,
 * et pour que la comparaison de coût porte sur une implémentation dont chaque octet est vérifié par
 * les vecteurs de la RFC. Rien ici ne descend dans `src/`.
 *
 * La construction est celle de l'annexe A de la RFC 8452 : POLYVAL se ramène à GHASH par renversement
 * des octets, parce que les deux corps emploient des polynômes et des conventions de bits inverses.
 *
 *     POLYVAL(H, X_1, …, X_n) =
 *       ByteReverse(GHASH(mulX_GHASH(ByteReverse(H)), ByteReverse(X_1), …, ByteReverse(X_n)))
 *
 * GHASH est retenu comme socle plutôt qu'une multiplication POLYVAL écrite directement : sa
 * multiplication « décalage à droite, réduction par 0xe1 » est l'algorithme le plus relu de la
 * littérature, et l'annexe A donne le couple de vecteurs qui vérifie la conversion elle-même.
 */

const BLOC = 16;

/** Renverse l'ordre des seize octets d'un bloc. C'est le `ByteReverse` de l'annexe A. */
export function renverserOctets(bloc) {
  const sortie = new Uint8Array(BLOC);
  for (let i = 0; i < BLOC; i += 1) sortie[i] = bloc[BLOC - 1 - i];
  return sortie;
}

/** Quatre mots de 32 bits gros-boutistes, la représentation de travail de GHASH. */
function versMots(bloc) {
  const mots = new Uint32Array(4);
  for (let i = 0; i < 4; i += 1) {
    mots[i] =
      ((bloc[i * 4] << 24) | (bloc[i * 4 + 1] << 16) | (bloc[i * 4 + 2] << 8) | bloc[i * 4 + 3]) >>>
      0;
  }
  return mots;
}

function versOctets(mots) {
  const bloc = new Uint8Array(BLOC);
  for (let i = 0; i < 4; i += 1) {
    bloc[i * 4] = (mots[i] >>> 24) & 0xff;
    bloc[i * 4 + 1] = (mots[i] >>> 16) & 0xff;
    bloc[i * 4 + 2] = (mots[i] >>> 8) & 0xff;
    bloc[i * 4 + 3] = mots[i] & 0xff;
  }
  return bloc;
}

/** Multiplication par x dans le corps de GHASH : un décalage d'un bit vers la droite, puis la réduction. */
function multiplierParXGhash(mots) {
  const v = Uint32Array.from(mots);
  const dernierBit = v[3] & 1;
  v[3] = ((v[3] >>> 1) | ((v[2] & 1) << 31)) >>> 0;
  v[2] = ((v[2] >>> 1) | ((v[1] & 1) << 31)) >>> 0;
  v[1] = ((v[1] >>> 1) | ((v[0] & 1) << 31)) >>> 0;
  v[0] = v[0] >>> 1;
  if (dernierBit) v[0] = (v[0] ^ 0xe1000000) >>> 0;
  return v;
}

/** Produit de deux éléments du corps de GHASH, bit à bit. Aucune table : le banc mesure SIV, pas GHASH. */
function multiplierGhash(x, y) {
  const z = new Uint32Array(4);
  let v = Uint32Array.from(y);
  for (let i = 0; i < 128; i += 1) {
    const bit = (x[i >>> 5] >>> (31 - (i & 31))) & 1;
    if (bit) {
      z[0] = (z[0] ^ v[0]) >>> 0;
      z[1] = (z[1] ^ v[1]) >>> 0;
      z[2] = (z[2] ^ v[2]) >>> 0;
      z[3] = (z[3] ^ v[3]) >>> 0;
    }
    v = multiplierParXGhash(v);
  }
  return z;
}

/**
 * POLYVAL(H, X_1, …, X_n) sur une suite de blocs de seize octets.
 *
 * @param {Uint8Array} cleH seize octets
 * @param {Uint8Array} blocs suite de blocs, longueur multiple de seize
 * @returns {Uint8Array} seize octets
 */
export function polyval(cleH, blocs) {
  if (cleH.length !== BLOC) throw new Error("POLYVAL : la clé fait seize octets");
  if (blocs.length % BLOC !== 0) throw new Error("POLYVAL : l'entrée est un multiple de seize");

  const cleGhash = multiplierParXGhash(versMots(renverserOctets(cleH)));
  let accumulateur = new Uint32Array(4);
  for (let position = 0; position < blocs.length; position += BLOC) {
    const bloc = versMots(renverserOctets(blocs.subarray(position, position + BLOC)));
    const entree = new Uint32Array(4);
    for (let i = 0; i < 4; i += 1) entree[i] = (accumulateur[i] ^ bloc[i]) >>> 0;
    accumulateur = multiplierGhash(entree, cleGhash);
  }
  return renverserOctets(versOctets(accumulateur));
}
