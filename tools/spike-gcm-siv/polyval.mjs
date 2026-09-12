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

/**
 * Multiplication par x dans le corps de GHASH, EN PLACE : un décalage d'un bit vers la droite,
 * puis la réduction. La version précédente rendait un tableau neuf à chaque appel, soit cent
 * vingt-huit allocations par produit — c'est une des deux raisons pour lesquelles la première
 * rédaction de ce module coûtait deux fois le plancher d'appels qu'elle accompagnait.
 */
function multiplierParXGhashEnPlace(v, decalage) {
  const dernierBit = v[decalage + 3] & 1;
  v[decalage + 3] = ((v[decalage + 3] >>> 1) | ((v[decalage + 2] & 1) << 31)) >>> 0;
  v[decalage + 2] = ((v[decalage + 2] >>> 1) | ((v[decalage + 1] & 1) << 31)) >>> 0;
  v[decalage + 1] = ((v[decalage + 1] >>> 1) | ((v[decalage] & 1) << 31)) >>> 0;
  v[decalage] = v[decalage] >>> 1;
  if (dernierBit) v[decalage] = (v[decalage] ^ 0xe1000000) >>> 0;
}

/**
 * Les cent vingt-huit multiples `H · x^i`, i de 0 à 127, à plat dans un seul tampon.
 *
 * C'est la seule optimisation de ce module, et elle est la reformulation exacte de la
 * multiplication bit à bit : `X · H = Σ x_i · x^i · H`. Au lieu de recalculer `H · x^i` pas à pas
 * à chaque produit, on le calcule une fois par MESSAGE — dans AES-GCM-SIV la clé POLYVAL est
 * dérivée à chaque nonce (RFC 8452, § 4), la table ne peut donc pas vivre plus longtemps qu'un
 * message, et elle s'amortit sur les quarante blocs d'un secteur.
 *
 * **Ce que cette forme ne fait PAS, et c'est une propriété qu'il faut écrire.** La table est
 * indexée par la POSITION du bit, de 0 à 127, et parcourue dans un ordre fixe : ce qui dépend du
 * secret est le OU-exclusif conditionnel, exactement comme dans la version bit à bit. Une table
 * indexée par un QUARTET de l'opérande — la forme classique dite de Shoup — irait plus vite encore
 * et ajouterait, elle, une dépendance d'ADRESSE au secret, donc une surface de temporisation par
 * cache. Ce module s'en abstient délibérément.
 */
function tableDesMultiples(cleGhash) {
  const table = new Uint32Array(128 * 4);
  table.set(cleGhash, 0);
  for (let i = 1; i < 128; i += 1) {
    const precedent = (i - 1) * 4;
    const courant = i * 4;
    table[courant] = table[precedent];
    table[courant + 1] = table[precedent + 1];
    table[courant + 2] = table[precedent + 2];
    table[courant + 3] = table[precedent + 3];
    multiplierParXGhashEnPlace(table, courant);
  }
  return table;
}

/** `accumulateur ← accumulateur · H`, par la table des multiples. Aucune allocation. */
function multiplierParTable(accumulateur, table) {
  let z0 = 0;
  let z1 = 0;
  let z2 = 0;
  let z3 = 0;
  for (let mot = 0; mot < 4; mot += 1) {
    let bits = accumulateur[mot];
    if (bits === 0) continue;
    const base = mot * 32 * 4;
    for (let rang = 0; rang < 32; rang += 1) {
      if ((bits & 0x80000000) !== 0) {
        const position = base + rang * 4;
        z0 ^= table[position];
        z1 ^= table[position + 1];
        z2 ^= table[position + 2];
        z3 ^= table[position + 3];
      }
      bits = (bits << 1) >>> 0;
    }
  }
  accumulateur[0] = z0 >>> 0;
  accumulateur[1] = z1 >>> 0;
  accumulateur[2] = z2 >>> 0;
  accumulateur[3] = z3 >>> 0;
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

  const cleGhash = versMots(renverserOctets(cleH));
  multiplierParXGhashEnPlace(cleGhash, 0);
  const table = tableDesMultiples(cleGhash);

  const accumulateur = new Uint32Array(4);
  const bloc = new Uint8Array(BLOC);
  for (let position = 0; position < blocs.length; position += BLOC) {
    for (let i = 0; i < BLOC; i += 1) bloc[i] = blocs[position + BLOC - 1 - i];
    accumulateur[0] =
      (accumulateur[0] ^ ((bloc[0] << 24) | (bloc[1] << 16) | (bloc[2] << 8) | bloc[3])) >>> 0;
    accumulateur[1] =
      (accumulateur[1] ^ ((bloc[4] << 24) | (bloc[5] << 16) | (bloc[6] << 8) | bloc[7])) >>> 0;
    accumulateur[2] =
      (accumulateur[2] ^ ((bloc[8] << 24) | (bloc[9] << 16) | (bloc[10] << 8) | bloc[11])) >>> 0;
    accumulateur[3] =
      (accumulateur[3] ^ ((bloc[12] << 24) | (bloc[13] << 16) | (bloc[14] << 8) | bloc[15])) >>> 0;
    multiplierParTable(accumulateur, table);
  }
  return renverserOctets(versOctets(accumulateur));
}
