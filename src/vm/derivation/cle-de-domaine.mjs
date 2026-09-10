// La DÉRIVATION PAR DOMAINE sous la clé maîtresse (ADR 0033, décisions 1 et 3 ; #182, #181).
//
// L'ADR 0033 décide que la DEK devient une clé MAÎTRESSE : plus rien n'est scellé sous elle
// directement, chaque domaine scelle sous une clé AEAD de 256 bits qui en descend par HKDF-SHA-256.
// Ce module est le seul endroit qui fabrique une telle clé, et il ne connaît qu'un domaine —
// `archive`, celui que #181 introduit. Les cinq autres arrivent avec #182, et le format de volume
// reste v3 d'ici là : sa clé reste la DEK, entorse assumée et écrite dans l'ADR 0033.
//
// ## Ce que l'info encode, et pourquoi chaque champ y est
//
//     info = LP("railsbox-vault/derivation-de-domaine/v1")   étiquette du SCHÉMA de dérivation
//          ‖ LP(domaine)                                      « archive », et cinq autres à venir
//          ‖ LP(identifiantVolume)                            32 hexadécimaux MINUSCULES
//          ‖ U32BE(versionDeFormatDuDomaine)                  la version du format que ce domaine scelle
//          ‖ LP("aes-256-gcm")                                l'algorithme, comme dans les données associées
//
// Les champs sont PRÉFIXÉS DE LEUR LONGUEUR, jamais joints par un séparateur : une concaténation non
// préfixée n'est injective que tant que les champs ne contiennent pas le séparateur, c'est-à-dire
// par une propriété du CONTENU et non de l'ENCODAGE. Le dépôt refuse ce genre de sûreté depuis #18,
// et ce qui vaut pour l'identité d'un bloc vaut a fortiori pour l'identité d'une CLÉ.
//
// ## Le sel porte l'unicité, l'info porte la séparation
//
// Le domaine `archive` est un domaine à USAGE UNIQUE : l'artefact est réécrit entier à chaque geste
// et ne porte qu'UN scellement. Son sel est donc TIRÉ — trente-deux octets de
// `crypto.getRandomValues` — et écrit EN CLAIR dans l'artefact. Une clé neuve par archive, un
// scellement sous cette clé, et aucun compteur.
//
// **Le sel en clair n'est pas authentifié, et il n'a pas à l'être.** Un adversaire qui le change
// obtient une clé différente, donc une ouverture qui échoue : le sel se protège par sa conséquence,
// exactement comme le nonce.

import { chainePrefixee, concatenerListe, entierEnOctets } from "../format-chiffre/octets.mjs";
import { ALGORITHME, CLE_OCTETS } from "../format-chiffre/identite-logique.mjs";
import { parametresRefuses } from "./derivation-errors.mjs";

/** Étiquette du SCHÉMA de dérivation. Elle sépare cette hiérarchie de toute autre sous la même DEK. */
export const ETIQUETTE_SCHEMA_DE_DOMAINE = "railsbox-vault/derivation-de-domaine/v1";

/**
 * Les domaines que ce runtime dérive. Un seul pour l'instant, et c'est délibéré : #181 introduit la
 * dérivation pour l'ARCHIVE, #182 l'étendra aux cinq autres (`volume`, `journal`, `instantane`,
 * `enveloppe`, `recuperation`) en même temps que le format de volume v4. Nommer ici des domaines
 * que rien ne dérive laisserait croire qu'ils existent.
 */
export const DOMAINES = Object.freeze({ archive: "archive" });

/** Largeur du sel d'un domaine à USAGE UNIQUE : trente-deux octets tirés, écrits en clair. */
export const SEL_DE_DOMAINE_OCTETS = 32;

/** Largeur de la clé maîtresse et de chaque clé dérivée. Celle de l'ADR 0015, jamais redécidée ici. */
export const CLE_DE_DOMAINE_OCTETS = CLE_OCTETS;

const DOMAINES_CONNUS = new Set(Object.values(DOMAINES));

/** Exige une chaîne de trente-deux hexadécimaux MINUSCULES : l'identifiant d'un volume v3. */
function identifiantDeVolume(valeur) {
  if (typeof valeur !== "string" || !/^[0-9a-f]{32}$/.test(valeur)) {
    throw parametresRefuses(
      `« identifiantVolume » doit être 32 hexadécimaux minuscules, reçu ${JSON.stringify(valeur)}.`,
      { champ: "identifiantVolume" },
    );
  }
  return valeur;
}

/**
 * L'INFO que HKDF reçoit pour un domaine, octet par octet.
 *
 * Elle est calculée AVANT qu'aucune clé n'existe, comme `infoDeLEmplacement` de l'ADR 0021 : un
 * identifiant malformé doit faire refuser la dérivation avant qu'un matériau ne soit importé.
 *
 * @param {{ domaine: string, identifiantVolume: string, versionDeFormat: number }} appel
 *   `versionDeFormat` est la version du format DU DOMAINE — 3 pour l'archive de #181 —, jamais celle
 *   du volume : lier chaque clé à la version du volume ferait bouger la clé d'un domaine à chaque
 *   version de volume (ADR 0033, décision 3).
 * @returns {Uint8Array}
 */
export function encoderInfoDeDomaine({ domaine, identifiantVolume, versionDeFormat }) {
  if (!DOMAINES_CONNUS.has(domaine)) {
    throw parametresRefuses(`Domaine de dérivation inconnu : ${JSON.stringify(domaine)}.`, {
      champ: "domaine",
      connus: [...DOMAINES_CONNUS],
    });
  }
  identifiantDeVolume(identifiantVolume);
  if (!Number.isSafeInteger(versionDeFormat) || versionDeFormat < 0) {
    throw parametresRefuses(
      `« versionDeFormat » doit être un entier non négatif, reçu ${JSON.stringify(versionDeFormat)}.`,
      { champ: "versionDeFormat" },
    );
  }
  return concatenerListe([
    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),
    chainePrefixee(domaine),
    chainePrefixee(identifiantVolume),
    entierEnOctets(versionDeFormat, 4),
    chainePrefixee(ALGORITHME),
  ]);
}

/** TIRE le sel d'un domaine à usage unique. Trente-deux octets, écrits en clair dans l'artefact. */
export function tirerSelDeDomaine() {
  return crypto.getRandomValues(new Uint8Array(SEL_DE_DOMAINE_OCTETS));
}

/**
 * DÉRIVE la clé d'un domaine : HKDF-SHA-256 sur la clé maîtresse, puis import AES-GCM **non
 * extractible**.
 *
 * Deux appels de WebCrypto seulement — pas de `deriveBits` suivi d'un `importKey`, qui ferait
 * exister les octets de la clé dans le tas JavaScript pour rien. La clé maîtresse, elle, n'est PAS
 * effacée ici : elle appartient à l'appelant, qui l'emploie encore pour le volume tant que #182 n'a
 * pas livré la v4.
 *
 * @param {{ cleMaitresse: Uint8Array, sel: Uint8Array, info: Uint8Array }} appel
 * @returns {Promise<CryptoKey>} AES-GCM 256, non extractible, `encrypt` et `decrypt`
 */
export async function deriverCleDeDomaine({ cleMaitresse, sel, info }) {
  if (!(cleMaitresse instanceof Uint8Array) || cleMaitresse.byteLength !== CLE_DE_DOMAINE_OCTETS) {
    throw parametresRefuses(
      `la clé maîtresse fait ${cleMaitresse?.byteLength ?? "une largeur inconnue"} octet(s) au lieu de ${CLE_DE_DOMAINE_OCTETS}.`,
      { attendu: CLE_DE_DOMAINE_OCTETS },
    );
  }
  if (!(sel instanceof Uint8Array) || sel.byteLength !== SEL_DE_DOMAINE_OCTETS) {
    throw parametresRefuses(
      `le sel de domaine fait ${sel?.byteLength ?? "une largeur inconnue"} octet(s) au lieu de ${SEL_DE_DOMAINE_OCTETS}.`,
      { attendu: SEL_DE_DOMAINE_OCTETS },
    );
  }
  const base = await crypto.subtle.importKey("raw", cleMaitresse, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: sel, info },
    base,
    { name: "AES-GCM", length: CLE_DE_DOMAINE_OCTETS * 8 },
    false,
    ["encrypt", "decrypt"],
  );
}
