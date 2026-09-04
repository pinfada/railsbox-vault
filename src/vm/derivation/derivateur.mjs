// Le CONTRAT COMMUN des deux dérivateurs, et le seul endroit qui fabrique une KEK (#22, ADR 0021).
//
// Un dérivateur est un objet à deux membres, et pas un de plus :
//
//     { type: number, deriver({ parametres, identite, geste }) → Promise<CryptoKey> }
//
// `type` est une valeur de `TYPES_KEK` (ADR 0020) ; `parametres` sont les octets publics que
// l'emplacement porte en clair et que sa DEK enveloppée AUTHENTIFIE ; `identite` est
// `{ identifiantVolume, identifiantEmplacement }`, lue du MANIFESTE et du fichier d'enveloppes ;
// `geste` porte ce que l'utilisateur fournit — une phrase, ou rien du tout quand c'est
// l'authentificateur qui parle.
//
// ## Pourquoi la KEK est une `CryptoKey` et jamais des octets
//
// #21 recevait une KEK en trente-deux octets, parce que le harnais la posait. #22 la fabrique à
// partir d'un SECRET UTILISATEUR, et le contrat change avec elle : `deriveKey` rend une clé **non
// extractible**, dont WebCrypto ne rendra jamais les octets — pas à un appelant distrait, pas à un
// message vers l'origine applicative, pas à un journal. C'est la seule barrière de ce dossier qui
// ne repose pas sur la discipline de celui qui écrit le code.
//
// **Ce que JavaScript garantit, et ce qu'il ne garantit pas**, puisque le contrat de #22 demande
// que ce soit écrit :
//
//  - GARANTI : les octets d'une `CryptoKey` non extractible ne sont pas atteignables depuis le
//    langage. `exportKey` rejette, et il n'existe aucune autre voie normative ;
//  - NON GARANTI : que le MATÉRIAU dont elle est tirée disparaisse. La phrase est une `string`
//    JavaScript — immuable, copiée par le moteur, ramassée quand il le décide, et impossible à
//    écraser. La sortie PRF et le matériau HKDF sont des `Uint8Array` : on peut les remplir de
//    zéros, et ce module le fait dès que la clé est importée, mais le moteur a pu en copier le
//    contenu lors d'un `importKey`, d'une promotion de génération ou d'un déplacement de tas. Ce
//    que l'effacement achète est une FENÊTRE REFERMÉE, pas une garantie ;
//  - NON GARANTI non plus : que la mémoire du processus ne parte pas dans un fichier d'échange ou
//    un vidage de plantage. Aucun code JavaScript ne peut verrouiller une page en mémoire.
//
// L'ADR 0021 le dit dans les mêmes termes, et `SECURITY.md` avec lui.

import { malforme } from "../enveloppe/enveloppe-errors.mjs";
import { CLE_OCTETS } from "../format-chiffre/identite-logique.mjs";
import { chainePrefixee, concatenerListe, entierEnOctets } from "../format-chiffre/octets.mjs";
import { parametresRefuses } from "./derivation-errors.mjs";

/** Largeur d'une KEK, en octets. Celle de l'ADR 0015, jamais redécidée ici. */
export const KEK_OCTETS = CLE_OCTETS;

/**
 * Largeur du MATÉRIAU qu'un dérivateur remet à HKDF : trente-deux octets.
 *
 * Ce n'est pas une coïncidence avec la largeur de la KEK, c'est la sortie des deux sources : une
 * étiquette Argon2id de 32 octets, ou la sortie PRF de WebAuthn, qui fait 32 octets par
 * spécification. Une largeur DIFFÉRENTE n'est pas tolérée : un authentificateur qui rendrait
 * seize octets rendrait une clé deux fois plus faible sans que rien ne le signale.
 */
export const MATERIAU_OCTETS = 32;

/** Version de la DÉRIVATION. Distincte du format d'enveloppe et du format de volume. */
export const DERIVATION_VERSION = 1;

/** Étiquette de domaine de l'info HKDF. Elle sépare cette dérivation de toute autre. */
export const ETIQUETTE_DOMAINE_DERIVATION = "railsbox-vault/derivation/v1/kek";

/** Exige une chaîne hexadécimale minuscule de longueur exacte, comme le fait l'ADR 0020. */
function hexadecimal(nom, valeur, octets) {
  if (typeof valeur !== "string" || !new RegExp(`^[0-9a-f]{${octets * 2}}$`).test(valeur)) {
    throw malforme(
      `« ${nom} » doit être ${octets * 2} hexadécimaux minuscules, reçu ${JSON.stringify(valeur)}.`,
      { champ: nom, attendu: octets * 2 },
    );
  }
  return valeur;
}

/**
 * L'INFO que HKDF reçoit : l'identité COMPLÈTE de ce que la clé va ouvrir.
 *
 * Chaque champ est préfixé de sa longueur ou de largeur fixe, pour la raison de l'ADR 0020 : sans
 * préfixe, un signe glissé d'un champ à l'autre laisserait les octets inchangés, et deux identités
 * distinctes tireraient la MÊME clé. Ici la conséquence serait pire qu'ailleurs — une passkey
 * enregistrée pour un emplacement ouvrirait l'emplacement voisin, sur un autre volume.
 *
 * L'emplacement y figure, et c'est ce qui oblige à le TIRER avant de dériver : voir
 * `emplacement-derive.mjs`, et l'amendement que l'ADR 0021 porte à l'ADR 0020.
 *
 * @param {{ identifiantVolume: string, identifiantEmplacement: string, version: number }} identite
 */
export function encoderInfoDerivation({ identifiantVolume, identifiantEmplacement, version }) {
  hexadecimal("identifiantVolume", identifiantVolume, 16);
  hexadecimal("identifiantEmplacement", identifiantEmplacement, 8);
  if (!Number.isSafeInteger(version) || version < 0 || version > 0xffffffff) {
    throw malforme(`« version » doit être un entier de 0 à 4294967295, reçu ${version}.`, {
      champ: "version",
    });
  }
  return concatenerListe([
    chainePrefixee(ETIQUETTE_DOMAINE_DERIVATION),
    chainePrefixee(identifiantVolume),
    chainePrefixee(identifiantEmplacement),
    entierEnOctets(version, 4),
  ]);
}

/** Efface un tampon de matériau. Fenêtre refermée, pas garantie — voir l'en-tête de ce fichier. */
export function effacer(octets) {
  if (octets instanceof Uint8Array) octets.fill(0);
}

/**
 * DÉRIVE la KEK : HKDF-SHA-256 sur le matériau, puis import AES-GCM **non extractible**.
 *
 * Le matériau est effacé dès que la clé existe. Deux appels de WebCrypto seulement — pas de
 * `deriveBits` suivi d'un `importKey`, qui ferait exister les octets de la clé dans le tas
 * JavaScript pour rien : `deriveKey` les garde du côté du moteur, où le langage ne les atteint pas.
 *
 * @param {{ materiau: Uint8Array, sel: Uint8Array, info: Uint8Array }} appel
 * @returns {Promise<CryptoKey>} AES-GCM 256, non extractible, `encrypt` et `decrypt`
 */
export async function deriverKek({ materiau, sel, info }) {
  if (!(materiau instanceof Uint8Array) || materiau.byteLength !== MATERIAU_OCTETS) {
    throw parametresRefuses(
      `le matériau à étirer fait ${materiau?.byteLength ?? "une largeur inconnue"} octet(s) au lieu de ${MATERIAU_OCTETS}.`,
      { attendu: MATERIAU_OCTETS },
    );
  }
  // `importKey` est DANS le try : il peut échouer — matériau d'une largeur que le moteur refuse,
  // contexte sans WebCrypto —, et un échec hors du try laisserait le matériau intact dans le tas.
  try {
    const base = await crypto.subtle.importKey("raw", materiau, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: sel, info },
      base,
      { name: "AES-GCM", length: KEK_OCTETS * 8 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    effacer(materiau);
  }
}

/**
 * L'INFO d'un emplacement, calculée AVANT qu'un matériau n'existe.
 *
 * C'est l'ordre qui compte, et c'est pour cela que ce geste est séparé. L'info est tirée du
 * MANIFESTE, c'est-à-dire d'un fichier : un `volume.id` malformé la fait refuser. Tant que ce
 * refus tombait APRÈS l'appel à Argon2 ou à l'authentificateur, il tombait sur un matériau déjà
 * calculé, que personne n'effaçait ensuite — un fichier touché par un adversaire suffisait donc à
 * laisser un étirement de phrase dans le tas. Le refus tombe désormais avant qu'il n'existe.
 *
 * Les deux dérivateurs appellent cette fonction puis `deriverKek`, dans cet ordre : c'est ce qui
 * garantit qu'ils n'ont pas deux façons d'assembler la même chose.
 *
 * @param {{ identifiantVolume: string, identifiantEmplacement: string }} identite
 */
export function infoDeLEmplacement(identite) {
  return encoderInfoDerivation({ ...identite, version: DERIVATION_VERSION });
}
