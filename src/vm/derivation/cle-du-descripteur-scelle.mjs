// La CLÉ de scellement du DESCRIPTEUR rangé au magasin d'artefacts (#247, lot D1g ; ADR 0046).
//
// Le descripteur que le magasin garde pour démarrer HORS CONNEXION n'est authentifié par rien
// d'extérieur à l'OPFS : un adversaire qui y écrit, sans la clé du coffre, pourrait fabriquer le
// document qui décide de ce que la machine démarre. Il est donc SCELLÉ — HMAC-SHA-256 — sous une clé
// qui descend de la clé du coffre, et que seul le Worker de confiance, après le déverrouillage,
// sait refaire.
//
// ## Un domaine à part, hors de la liste close de l'ADR 0033
//
// C'est le MÊME mécanisme que `cle-de-domaine.mjs` (HKDF-SHA-256, info à champs préfixés de leur
// longueur, clé NON extractible, jamais la DEK directement), mais ce n'est pas un septième domaine
// AEAD : la liste de l'ADR 0033 est close parce que chacun de ses domaines porte un BUDGET de clé
// (nonces d'AES-GCM, ADR 0015). Un HMAC n'a pas de nonce — il est déterministe, donc sans budget — et
// l'ajouter à la liste ferait compter un compteur qui n'existe pas. Le domaine vit donc ici, avec sa
// propre étiquette, et l'ADR 0046 le dit.
//
//     info = LP("railsbox-vault/derivation-de-domaine/v1")   le schéma de l'ADR 0033, inchangé
//          ‖ LP("descripteur")                               le domaine : aucun des six autres
//          ‖ LP(identifiantVolume)                           32 hexadécimaux minuscules
//          ‖ U32BE(versionDeFormat)                          celle du FORMAT du descripteur scellé
//          ‖ LP("hmac-sha-256")                              l'algorithme
//
// **Sel vide**, comme les domaines à compteur : la clé est la même d'une écriture à l'autre, sans
// quoi le fichier rangé hier ne se vérifierait pas aujourd'hui. RFC 5869 § 2.2 : un sel absent vaut
// `HashLen` octets nuls, et l'extraction reste correcte parce que l'IKM est uniformément aléatoire.
//
// **Séparation.** Trois différences indépendantes rendent la clé HMAC distincte de toute clé AEAD du
// même coffre : le champ de domaine de l'info, l'algorithme de l'info, et le type de la clé
// importée (HMAC, qui ne chiffre pas). Aucune n'est seule porteuse.

import { chainePrefixee, concatenerListe, entierEnOctets } from "../format-chiffre/octets.mjs";
import { ETIQUETTE_SCHEMA_DE_DOMAINE, importerMateriauMaitre } from "./cle-de-domaine.mjs";
import { parametresRefuses } from "./derivation-errors.mjs";

/** Le nom du domaine. Il n'est dans AUCUNE des listes de l'ADR 0033. */
export const DOMAINE_DU_DESCRIPTEUR = "descripteur";

/** Version du FORMAT du descripteur scellé (`descripteur-scelle.mjs`) : elle entre dans la clé. */
export const VERSION_DE_FORMAT_DU_DESCRIPTEUR = 1;

const ALGORITHME_DU_SCELLEMENT = "hmac-sha-256";
const CLE_OCTETS = 32;
const SEL_VIDE = new Uint8Array(0);

/**
 * L'INFO que HKDF reçoit, octet par octet. Calculée avant tout matériau : un identifiant malformé
 * est refusé avant qu'une clé n'existe.
 *
 * @param {{ identifiantVolume: string, versionDeFormat?: number }} appel
 */
export function encoderInfoDuDescripteur({
  identifiantVolume,
  versionDeFormat = VERSION_DE_FORMAT_DU_DESCRIPTEUR,
}) {
  if (typeof identifiantVolume !== "string" || !/^[0-9a-f]{32}$/.test(identifiantVolume)) {
    throw parametresRefuses(
      `« identifiantVolume » doit être 32 hexadécimaux minuscules, reçu ${JSON.stringify(identifiantVolume)}.`,
      { champ: "identifiantVolume" },
    );
  }
  return concatenerListe([
    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),
    chainePrefixee(DOMAINE_DU_DESCRIPTEUR),
    chainePrefixee(identifiantVolume),
    entierEnOctets(versionDeFormat, 4),
    chainePrefixee(ALGORITHME_DU_SCELLEMENT),
  ]);
}

function exigerLeMateriau(cle) {
  if (cle?.algorithm?.name !== "HKDF" || !cle.usages?.includes("deriveKey")) {
    throw parametresRefuses(
      "« cleMaitresse » doit être les octets de la clé du coffre ou le matériau HKDF qu'« importerMateriauMaitre » rend : une clé AES-GCM ne dérive rien.",
      { champ: "cleMaitresse", algorithme: cle?.algorithm?.name ?? null },
    );
  }
  return cle;
}

/**
 * DÉRIVE la clé de scellement : HKDF-SHA-256 sur la clé du coffre, puis import HMAC-SHA-256 **non
 * extractible**, `sign` et `verify` seulement. Deux appels de WebCrypto : aucun octet de la clé
 * n'existe dans le tas JavaScript.
 *
 * @param {{ cleMaitresse: Uint8Array | CryptoKey, identifiantVolume: string,
 *           versionDeFormat?: number }} appel
 * @returns {Promise<CryptoKey>}
 */
export async function deriverCleDeScellementDuDescripteur({
  cleMaitresse,
  identifiantVolume,
  versionDeFormat = VERSION_DE_FORMAT_DU_DESCRIPTEUR,
}) {
  const info = encoderInfoDuDescripteur({ identifiantVolume, versionDeFormat });
  const base =
    cleMaitresse instanceof Uint8Array
      ? await importerMateriauMaitre(cleMaitresse)
      : exigerLeMateriau(cleMaitresse);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SEL_VIDE, info },
    base,
    { name: "HMAC", hash: "SHA-256", length: CLE_OCTETS * 8 },
    false,
    ["sign", "verify"],
  );
}
