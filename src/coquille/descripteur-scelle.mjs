// Le DESCRIPTEUR SCELLÉ : le format persistant que le magasin d'artefacts garde pour démarrer HORS
// CONNEXION (#247, lot D1g ; ADR 0045).
//
// Ce que le fichier est : une copie du descripteur applicatif que l'origine a servi, rangée APRÈS une
// acquisition complète, et SCELLÉE — HMAC-SHA-256 — sous une clé que seul le coffre déverrouillé sait
// dériver (`cle-du-descripteur-scelle.mjs`). Ce qu'il n'est pas : une vérité. Il ne fait foi que si
// l'origine est INJOIGNABLE (`hors-connexion.mjs`), et même alors il repasse par la décision de
// déphasage (ADR 0042) comme un descripteur servi.
//
// ## Format, version 1 (tout est gros-boutiste)
//
//     offset  taille  champ
//          0       8  magie « VLTDSC01 » (ASCII) — « 01 » est la version du format
//          8       8  rangeLe : U64, millisecondes depuis l'époque Unix — la date de la dernière
//                     vérification contre l'origine, celle que la personne lit
//         16       4  longueur L de la charge, U32, au plus TAILLE_MAX_DE_LA_CHARGE
//         20       L  charge : JSON UTF-8 `{ "descripteur": …, "manifesteV86": … }`
//       20+L      32  sceau : HMAC-SHA-256( LP(ÉTIQUETTE) ‖ octets[0 .. 20+L) )
//
// **Ce que le sceau authentifie** : TOUT ce qui précède — la magie (donc la version), la date, la
// longueur et la charge —, sous une étiquette de domaine propre à ce scellement. Rien n'est lu comme
// décision avant la vérification, sauf la longueur, qui n'est jamais crue au-delà de la taille du
// fichier (elle doit en être exactement le complément).
//
// **La charge est ce qui a été acquis, pas ce qui est recalculé** : les octets scellés sont ceux du
// JSON écrit au scellement, jamais re-sérialisés à la vérification. Aucune canonicalisation.
//
// ## Ce qui est refusé, jamais accepté
//
//  - une autre magie — une autre version du format, ou un descripteur NON scellé (le JSON servi, tel
//    quel) — : refus « format ». Un fichier d'une version antérieure ne devient pas « acceptable au
//    mieux » : il est refusé, et le prochain démarrage EN LIGNE le remplace ;
//  - un sceau faux — fabriqué sans la clé, altéré, scellé par un autre coffre — : refus « sceau » ;
//  - un contenu dont la forme est refusée (`formeDuDescripteur`, forme du manifeste v86), même scellé
//    par le bon coffre : refus « contenu ». Le sceau dit QUI a écrit, pas que le contenu est sain.

import { chainePrefixee, concatener } from "../vm/format-chiffre/octets.mjs";
import { formeDuDescripteur } from "./descripteur-applicatif.mjs";
import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

export const MAGIE_DU_DESCRIPTEUR_SCELLE = "VLTDSC01";
export const EN_TETE_OCTETS = 20;
export const TAILLE_DU_SCEAU = 32;
/** Un descripteur pèse quelques kilo-octets ; au-delà d'un Mio, ce n'en est pas un. */
export const TAILLE_MAX_DE_LA_CHARGE = 1024 * 1024;
/** L'étiquette de domaine du SCELLEMENT : elle sépare ce MAC de tout autre emploi de la même clé. */
export const ETIQUETTE_DU_SCELLEMENT = "railsbox-vault/descripteur-scelle/v1";

const MAGIE = new TextEncoder().encode(MAGIE_DU_DESCRIPTEUR_SCELLE);
const EMPREINTE = /^[0-9a-f]{64}$/;
const NOM_V86 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARTEFACTS_V86_MAX = 16;

/** Le refus typé d'un descripteur rangé : un code, une RAISON de la liste fermée — rien du contenu. */
export class DescripteurRangeRefuse extends Error {
  constructor(raison) {
    super(`Descripteur rangé refusé (${raison}).`);
    this.name = "DescripteurRangeRefuse";
    this.code = C.horsLigneDescripteurRefuse;
    this.contexte = Object.freeze({ raison });
  }

  toJSON() {
    return { code: this.code, message: this.message, contexte: this.contexte };
  }
}

/** Les raisons, fermées : `format` (forme du fichier), `sceau`, `contenu` (forme du contenu scellé). */
export const RAISONS_DU_REFUS = Object.freeze(["format", "sceau", "contenu"]);

/** Ce que le sceau couvre : l'étiquette de domaine, puis TOUS les octets avant le sceau. */
const donneesScellees = (avantLeSceau) =>
  concatener(chainePrefixee(ETIQUETTE_DU_SCELLEMENT), avantLeSceau);

/**
 * La forme du manifeste v86 rangé (les adresses et empreintes de `libv86` et du `wasm`, que le boot
 * hors connexion ne peut pas aller relire) : une liste bornée de `{ name, bytes, sha256 }`.
 */
function formeDuManifesteV86(manifeste) {
  const artefacts = manifeste?.artifacts;
  if (!Array.isArray(artefacts) || artefacts.length === 0 || artefacts.length > ARTEFACTS_V86_MAX) {
    return false;
  }
  return artefacts.every(
    (artefact) =>
      NOM_V86.test(String(artefact?.name ?? "")) &&
      Number.isSafeInteger(artefact?.bytes) &&
      artefact.bytes > 0 &&
      EMPREINTE.test(String(artefact?.sha256 ?? "")),
  );
}

/** Réduit un manifeste v86 à ce que le boot lit : `{ artifacts: [{ name, bytes, sha256 }] }`. */
export function manifesteV86Reduit(manifeste) {
  const artefacts = Array.isArray(manifeste?.artifacts) ? manifeste.artifacts : [];
  return {
    artifacts: artefacts.map((artefact) => ({
      name: artefact?.name,
      bytes: artefact?.bytes,
      sha256: artefact?.sha256,
    })),
  };
}

/**
 * SCELLE un descripteur acquis.
 *
 * @param {{ descripteur: object, manifesteV86: object, rangeLe: number, cle: CryptoKey }} entrees
 *   `cle` : la clé HMAC de `deriverCleDeScellementDuDescripteur`. `rangeLe` : l'instant de la
 *   vérification, en millisecondes — il est AFFICHÉ, jamais utilisé pour décider.
 * @returns {Promise<Uint8Array>}
 */
export async function sceller({ descripteur, manifesteV86, rangeLe, cle }) {
  if (!Number.isSafeInteger(rangeLe) || rangeLe < 0) {
    throw new TypeError(`La date de rangement doit être un entier non négatif : ${rangeLe}.`);
  }
  const charge = new TextEncoder().encode(
    JSON.stringify({ descripteur, manifesteV86: manifesteV86Reduit(manifesteV86) }),
  );
  if (charge.byteLength > TAILLE_MAX_DE_LA_CHARGE) {
    throw new RangeError(`Charge de ${charge.byteLength} octets : au-delà de la borne.`);
  }
  const enTete = new Uint8Array(EN_TETE_OCTETS);
  const vue = new DataView(enTete.buffer);
  enTete.set(MAGIE, 0);
  vue.setBigUint64(8, BigInt(rangeLe));
  vue.setUint32(16, charge.byteLength);
  const avantLeSceau = concatener(enTete, charge);
  const sceau = new Uint8Array(
    await crypto.subtle.sign("HMAC", cle, donneesScellees(avantLeSceau)),
  );
  return concatener(avantLeSceau, sceau);
}

/** `true` si les `longueur` premiers octets de `octets` sont la magie de la version 1. */
const porteLaMagie = (octets) => MAGIE.every((octet, index) => octets[index] === octet);

/**
 * OUVRE un descripteur rangé, ou REFUSE (`DescripteurRangeRefuse`).
 *
 * L'ordre est celui de la défiance : la forme du fichier (sans rien allouer au-delà de sa taille),
 * PUIS le sceau, PUIS seulement la lecture du JSON, PUIS la forme du contenu. Le contenu d'un fichier
 * dont le sceau ne tient pas n'est jamais interprété.
 *
 * @param {{ octets: Uint8Array, cle: CryptoKey }} entrees
 * @returns {Promise<{ descripteur: object, manifesteV86: object, rangeLe: number }>}
 */
export async function ouvrirLeDescripteurScelle({ octets, cle }) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < EN_TETE_OCTETS + TAILLE_DU_SCEAU) {
    throw new DescripteurRangeRefuse("format");
  }
  if (!porteLaMagie(octets)) throw new DescripteurRangeRefuse("format");
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const longueur = vue.getUint32(16);
  if (
    longueur > TAILLE_MAX_DE_LA_CHARGE ||
    octets.byteLength !== EN_TETE_OCTETS + longueur + TAILLE_DU_SCEAU
  ) {
    throw new DescripteurRangeRefuse("format");
  }
  const avantLeSceau = octets.subarray(0, EN_TETE_OCTETS + longueur);
  // `verify` compare en temps constant : la comparaison n'est pas écrite ici.
  const authentique = await crypto.subtle.verify(
    "HMAC",
    cle,
    octets.subarray(EN_TETE_OCTETS + longueur),
    donneesScellees(avantLeSceau),
  );
  if (!authentique) throw new DescripteurRangeRefuse("sceau");
  const rangeLe = Number(vue.getBigUint64(8));
  let charge;
  try {
    charge = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(avantLeSceau.subarray(EN_TETE_OCTETS)),
    );
  } catch {
    throw new DescripteurRangeRefuse("contenu");
  }
  if (
    !Number.isSafeInteger(rangeLe) ||
    !formeDuDescripteur(charge?.descripteur).valide ||
    !formeDuManifesteV86(charge?.manifesteV86)
  ) {
    throw new DescripteurRangeRefuse("contenu");
  }
  return { descripteur: charge.descripteur, manifesteV86: charge.manifesteV86, rangeLe };
}
