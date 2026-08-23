// Géométrie commune aux backends de blocs. Elle était portée par `memory-block-backend.mjs` du
// spike #4 ; le backend OPFS de #6 exige les mêmes règles, donc elles vivent ici plutôt qu'en deux
// exemplaires divergents.

/** Secteur ATA : plus petite unité que le matériel émulé sait adresser. */
export const SECTOR_SIZE = 512;

/**
 * Granularité du contrat de tampon de v86. Ses tampons asynchrones (`AsyncXHRBuffer`) adressent et
 * mettent en cache par blocs de 256 octets ; un volume dont la taille n'en serait pas un multiple
 * exposerait un bloc final incomplet à l'émulateur.
 *
 * La contrainte est SUBSUMÉE par le secteur : 512 est un multiple de 256, et le spike #4 a mesuré
 * que le guest n'émet jamais d'accès en fraction de secteur
 * (`docs/spikes/0004-backend-de-blocs-v86.md`, « Alignement »). Exiger l'alignement secteur suffit
 * donc, mais la constante reste nommée pour que la vérification soit explicite plutôt que
 * accidentelle.
 */
export const V86_BLOCK_SIZE = 256;

if (SECTOR_SIZE % V86_BLOCK_SIZE !== 0) {
  throw new Error(
    `Géométrie incohérente : un secteur de ${SECTOR_SIZE} octets doit être un multiple du bloc v86 de ${V86_BLOCK_SIZE}.`,
  );
}

/** Vrai si `size` est une géométrie de volume admissible. */
export function isBlockGeometry(size) {
  return Number.isInteger(size) && size > 0 && size % SECTOR_SIZE === 0;
}

/**
 * Refuse une géométrie inadmissible plutôt que de l'arrondir. Un volume arrondi en silence rendrait
 * `size()` incohérent avec ce que l'appelant croit avoir demandé.
 * @param {number} size
 */
export function assertBlockGeometry(size) {
  if (!isBlockGeometry(size)) {
    throw new RangeError(
      `Taille de volume invalide : ${size}. Un multiple entier de ${SECTOR_SIZE} octets est exigé.`,
    );
  }
  return size;
}
