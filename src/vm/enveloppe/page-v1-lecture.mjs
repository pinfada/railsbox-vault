// La LECTURE d'une page d'enveloppe **v1**, et rien d'autre (#182, T2b ; ADR 0020, ADR 0036).
//
// Avant T2b, la racine d'une page de `<volume>.cles` était scellée sous la DEK elle-même (ADR 0020,
// décision 3). La v2 la scelle sous une clé à usage unique dérivée par domaine, et la migration de
// page rescelle une v1 à sa première ouverture réussie. Entre les deux, il reste un geste à faire :
// **relire la v1**. C'est tout ce que ce module fait, et c'est pourquoi il existe seul.
//
// ## Pourquoi un module à lui, plutôt que trois lignes dans l'ouvreur
//
// Parce que c'est une EXCEPTION, et qu'une exception doit avoir un nom. Le cliquet anti-DEK de T2b
// (`tests/unit/vm-cliquet-anti-dek.test.mjs`) refuse qu'un module de `src/` ou de `public/`
// construise une clé AES-GCM depuis une clé de volume, et tient la liste de ceux qui le font encore
// avec leur raison. Laisser ce geste dans `etat-de-lenveloppe.mjs` aurait inscrit sur cette liste
// **l'ouvreur d'enveloppe entier** — c'est-à-dire le chemin par lequel tout déverrouillage passe —,
// et la liste aurait cessé de dire quoi que ce soit d'utile.
//
// ## Cette clé ne peut PAS chiffrer, et ce n'est pas une discipline
//
// Elle est importée avec le seul usage `decrypt`. Une `CryptoKey` dont les usages ne portent pas
// `encrypt` fait REJETER `crypto.subtle.encrypt` par la spécification WebCrypto elle-même : au
// vocabulaire de la décision 7 de l'ADR 0021, c'est un **GARANTI**, pas un « fait, non garanti ».
// C'est la même construction que la décision 6 de l'ADR 0033 applique à la DEK — importée en
// matériau HKDF, donc incapable de chiffrer —, appliquée ici un cran plus bas : ce module lit un
// format hérité, il n'écrit rien, et la plate-forme le tient à sa place.
//
// ## Ce qu'il ne fait pas
//
// Il ne décide pas QUAND une page v1 est relue, ni ce qu'on en fait ensuite. La règle de migration —
// « une page v1 est rescellée en v2 à la première ouverture RÉUSSIE, sous le bail exclusif » — vit
// dans `enveloppe-de-cle.mjs`, avec le support qu'elle a besoin d'écrire. Ici, on ouvre une racine.

import { ALGORITHME_WEBCRYPTO, CLE_OCTETS } from "./identite-enveloppe.mjs";
import { malforme } from "./enveloppe-errors.mjs";

/**
 * Importe la clé de volume d'un volume dont la page d'enveloppe est encore en **v1**, pour la
 * LECTURE de sa racine.
 *
 * @param {Uint8Array} dek exactement `CLE_OCTETS` octets
 * @returns {Promise<CryptoKey>} AES-GCM 256, non extractible, **`decrypt` seul**
 */
export async function importerCleDeRacineV1(dek) {
  if (!(dek instanceof Uint8Array) || dek.byteLength !== CLE_OCTETS) {
    throw malforme(
      `une clé de volume fait exactement ${CLE_OCTETS} octets, reçu ${dek?.byteLength ?? "autre chose"}.`,
      { attendu: CLE_OCTETS },
    );
  }
  return crypto.subtle.importKey("raw", dek, { name: ALGORITHME_WEBCRYPTO }, false, ["decrypt"]);
}
