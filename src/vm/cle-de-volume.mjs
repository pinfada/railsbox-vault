// Approvisionnement de la clé de volume (#18, ADR 0016, décision 6).
//
// L'ADR 0015 réserve à #21 les clés de déverrouillage, l'enveloppe DEK/KEK et la dérivation. #18 ne
// les anticipe pas, et ce module dit exactement ce qui reste possible en attendant :
//
//  - **le produit ne fabrique aucune clé de volume, et n'en persiste aucune.** Un volume v3 présenté
//    sans clé est REFUSÉ par `VAULT_STORAGE_CLE_REQUISE`, avant toute lecture. Rien n'est rendu en
//    clair, aucun repli n'est tenté. Une clé que le produit fabriquerait et rangerait à côté du
//    volume serait un chiffrement sans secret — c'est-à-dire une promesse fausse ;
//  - **les bancs et les épreuves** reçoivent une clé de TEST du HARNAIS, sous jeton. La garde est
//    celle de `crash-harness.mjs`, mot pour mot : sous Node, la variable d'environnement du
//    processus ; dans un Worker de navigateur — où il n'y a pas d'environnement de processus —, le
//    jeton exact que seule la page du banc transmet.
//
// La garde du Worker est donnée pour ce qu'elle est, comme celle de l'injecteur d'arrêts : elle
// interdit l'usage ACCIDENTEL et rend l'intention explicite ; elle ne prétend pas résister à un
// appelant décidé qui vit déjà dans le Worker.
//
// ## Le jeton est PUBLIC, et il faut le dire (revue de la PR #166, constat 1)
//
// Ce fichier écrivait « aucun chemin du produit ne la transmet ». Ce n'est plus vrai depuis #161 :
// la coquille de produit LIT le jeton d'un paramètre d'URL et le transmet au Worker de confiance,
// qui s'en sert pour ouvrir un volume tant que la tranche 2 (#162) n'a pas mis le vrai
// déverrouillage à sa place. Et ce module est PUBLIÉ — sans étape de construction, une constante que
// le produit compare existe forcément dans le code servi, sur les deux origines.
//
// Ce que le dépôt promet est donc autre chose, et c'est plus fort qu'un secret mal gardé :
//
//  - **la valeur ne protège rien.** Elle ouvre la clé de TEST, trente-deux octets publics sans
//    entropie, et un volume scellé sous elle est un banc, pas un coffre ;
//  - **la connaître ne sert à rien depuis l'origine applicative.** Le jeton ne s'emploie que sur le
//    canal PRIVILÉGIÉ, qu'aucun message du document applicatif n'atteint.
//    `tests/browser/coquille-frontiere.spec.mjs` › « le jeton du harnais est PUBLIC, lisible d'ici,
//    et ne sert à rien d'ici » le LIT depuis l'origine applicative — témoin positif — puis le
//    présente par tous les chemins qu'elle a, et relève que l'état de la coquille n'a pas bougé ;
//  - **un seul fichier publié le porte**, celui-ci, et `tests/unit/coquille-fixture.test.mjs`
//    rougirait sur un second.
//
// Cette porte est PROVISOIRE. La tranche 2 la referme, et c'est la réserve écrite de
// `SEC-ORIGIN-001` côté produit dans `SECURITY.md`.

import { CLE_OCTETS } from "./format-chiffre/identite-logique.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/** Variable d'environnement exigée du harnais, sous Node. */
export const HARNAIS_CLE_ENV = "VAULT_HARNAIS_CLE_DE_VOLUME";

/** Valeur exacte attendue. Une valeur approchante n'ouvre rien. */
export const HARNAIS_CLE_VALEUR = "cle-de-test";

/** Jeton exigé d'un Worker de navigateur, faute d'environnement de processus. */
export const HARNAIS_CLE_JETON = "vault/harnais-cle-de-volume/cle-de-test";

/**
 * Clé de TEST du harnais : trente-deux octets SANS ENTROPIE, publics, et sans aucune valeur.
 *
 * Ce sont les mêmes octets que la clé de test des vecteurs de l'ADR 0015 (`0x00` à `0x1f`), et c'est
 * délibéré : un banc qui scellerait sous une autre clé ne pourrait pas être confronté aux vecteurs.
 * Elle ne protège rien. Elle est nommée TEST ici, dans les vecteurs et dans l'ADR 0016, pour qu'un
 * relecteur qui tombe dessus le sache en une ligne.
 */
export const CLE_DE_TEST = Uint8Array.from({ length: CLE_OCTETS }, (_, index) => index);

const REFUS_HARNAIS =
  `La clé de volume de TEST ne se distribue que dans le harnais. Sous Node, le processus doit ` +
  `porter ${HARNAIS_CLE_ENV}=${HARNAIS_CLE_VALEUR} ; dans un Worker de navigateur, l'appel doit ` +
  `présenter le jeton du harnais. Aucun chemin du produit ne les transmet : une clé distribuée ` +
  `ici serait un chiffrement sans secret.`;

/**
 * Rend la clé de TEST du harnais, ou refuse bruyamment.
 *
 * Bruyamment, et non par `null` : une garde qui rendrait une valeur nulle finirait par être ignorée
 * par un appelant pressé, qui ouvrirait alors un volume sans clé.
 *
 * @param {{ jeton?: string }} [options] `jeton` n'est lu que hors processus Node
 * @returns {Uint8Array} `CLE_OCTETS` octets de TEST
 */
export function cleDeVolumeDuHarnais({ jeton } = {}) {
  const environnement = globalThis.process?.env;
  if (environnement) {
    if (environnement[HARNAIS_CLE_ENV] === HARNAIS_CLE_VALEUR) return CLE_DE_TEST;
    throw new Error(REFUS_HARNAIS);
  }
  if (jeton === HARNAIS_CLE_JETON) return CLE_DE_TEST;
  throw new Error(REFUS_HARNAIS);
}

/**
 * Clés de DÉVERROUILLAGE de TEST du harnais (#21, ADR 0020).
 *
 * Elles vivent ici, dans le module que `tests/unit/harnais-portes.test.mjs` surveille déjà, et pas
 * dans un banc : c'est ce qui garde EN UN SEUL ENDROIT tout ce que le dépôt tient de matériel de
 * clé en dur. Elles n'ont pas plus d'entropie que la clé de volume de TEST, et pas davantage de
 * valeur — 0x80 à 0x9f pour la première, 0xa0 à 0xbf pour la deuxième, 0xc0 à 0xdf pour la
 * troisième.
 *
 * Deux d'abord, parce qu'un banc de ROTATION en demande deux : remplacer une clé et montrer que
 * l'ancienne n'ouvre plus exige une clé neuve, et une clé neuve fabriquée par le banc serait une clé
 * en dur de plus, hors de portée de la garde. **Une troisième depuis #148**, pour la même raison
 * exactement : la révocation d'urgence ne prouve rien sur une enveloppe à deux emplacements — il en
 * faut au moins TROIS pour que « tous sauf un » diffère de « celui-là ».
 *
 * @param {{ jeton?: string }} [options] même garde, mot pour mot, que `cleDeVolumeDuHarnais`
 * @returns {{ initiale: Uint8Array, rotation: Uint8Array, tierce: Uint8Array }}
 */
export function clesDeDeverrouillageDuHarnais({ jeton } = {}) {
  cleDeVolumeDuHarnais({ jeton });
  return Object.freeze({
    initiale: Uint8Array.from({ length: CLE_OCTETS }, (_, index) => (0x80 + index) % 256),
    rotation: Uint8Array.from({ length: CLE_OCTETS }, (_, index) => (0xa0 + index) % 256),
    tierce: Uint8Array.from({ length: CLE_OCTETS }, (_, index) => (0xc0 + index) % 256),
  });
}

/**
 * EXIGE une clé de volume. C'est le refus typé de l'ADR 0016 : il tombe avant toute lecture, il
 * nomme l'issue qui le lèvera, et il ne fabrique rien.
 *
 * @param {string} volume nom du volume, pour que l'exploitant sache lequel
 * @param {Uint8Array | null | undefined} cleOctets
 * @returns {Uint8Array} la clé, telle quelle, si elle est admissible
 * @throws {StorageError} `VAULT_STORAGE_CLE_REQUISE`
 */
export function exigerCleDeVolume(volume, cleOctets) {
  if (cleOctets === null || cleOctets === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.cleRequise,
      `Volume « ${volume} » refusé : le format v3 est chiffré et aucune clé de volume n'a été remise. Le produit n'en fabrique aucune — les clés de déverrouillage et l'enveloppe sont l'objet de #21. Aucun octet n'est lu.`,
      { volume },
    );
  }
  if (!(cleOctets instanceof Uint8Array) || cleOctets.byteLength !== CLE_OCTETS) {
    throw new StorageError(
      STORAGE_ERROR_CODES.cleRequise,
      `Volume « ${volume} » refusé : une clé de volume fait exactement ${CLE_OCTETS} octets, reçu ${cleOctets?.byteLength ?? "autre chose"}. Une clé approchante n'est pas une clé.`,
      { volume, attendu: CLE_OCTETS },
    );
  }
  return cleOctets;
}
