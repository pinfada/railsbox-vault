// Fixture binaire déterministe des preuves de persistance.
//
// Le dépôt refuse les binaires versionnés opaques : `docs/testing.md` pose que les données de test
// sont synthétiques, déterministes et reproductibles depuis une RÈGLE. Cette fixture suit la même
// convention que la pièce jointe d'invariant d'`apps/reference/` — bloc `i` de 32 octets valant
// `SHA-256(label + i)` — de sorte que l'empreinte publiée ci-dessous soit vérifiée par le calcul
// à chaque exécution, et non recopiée à la main.
//
// Elle est calculée avec `crypto.subtle`, présent à l'identique sous Node 22 et dans un Worker :
// la même fixture est donc produite des deux côtés de la preuve.

const encoder = new TextEncoder();

/** Étiquette d'entrée de la dérivation. Un préfixe propre à Vault, jamais un mot au hasard. */
export const FIXTURE_LABEL = "railsbox-vault/opfs/bloc/";

/** Un bloc de fixture est une empreinte SHA-256 complète. */
export const FIXTURE_BLOCK_SIZE = 32;

/** Taille de la fixture de référence : 2048 blocs, soit 64 Kio. */
export const FIXTURE_SIZE = 64 * 1024;

/** Empreinte SHA-256 de `buildBlockFixture(FIXTURE_SIZE)`, vérifiée par les tests unitaires. */
export const FIXTURE_DIGEST = "92c10d219563658d1c07a1921687014a0bfeb630241c979d0906af902a426fd6";

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

/** Empreinte SHA-256 en hexadécimal minuscule. */
export async function digestHex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const value of digest) hex += HEX[value];
  return hex;
}

/**
 * Construit la fixture. Une taille qui n'est pas un multiple du bloc est refusée : l'arrondir
 * produirait deux fixtures différentes sous le même nom.
 * @param {number} size
 * @returns {Promise<Uint8Array>}
 */
export async function buildBlockFixture(size) {
  if (!Number.isInteger(size) || size <= 0 || size % FIXTURE_BLOCK_SIZE !== 0) {
    throw new RangeError(
      `Taille de fixture invalide : ${size}. Un multiple entier de ${FIXTURE_BLOCK_SIZE} octets est exigé.`,
    );
  }
  const bytes = new Uint8Array(size);
  const blocks = size / FIXTURE_BLOCK_SIZE;
  for (let index = 0; index < blocks; index += 1) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${FIXTURE_LABEL}${index}`),
    );
    bytes.set(new Uint8Array(digest), index * FIXTURE_BLOCK_SIZE);
  }
  return bytes;
}

/**
 * Motif court et déterministe, pour les régions qui ne sont pas la fixture principale : écriture
 * non alignée, secteur isolé, dernier bloc du volume.
 * @param {number} length
 * @param {number} seed
 */
export function buildPattern(length, seed) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + seed * 97 + 11) % 256;
  }
  return bytes;
}
