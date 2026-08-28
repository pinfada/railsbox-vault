// Disposition du fichier d'enveloppes `<volume>.cles` (#21, ADR 0020).
//
// Ce module ne chiffre rien et ne touche à aucun support : il dit OÙ les octets vivent, comme
// `volume-chiffre-format.mjs` le fait pour le volume. Il est pur, et c'est ce qui permet d'éprouver
// la troncature, le réordonnancement et le rejeu sans OPFS ni navigateur.
//
//     [ page A, 8192 octets ][ page B, 8192 octets ]
//
// ## Pourquoi DEUX pages, et pas un fichier temporaire renommé
//
// L'atomicité exigée par #21 est celle de l'ADR 0014, mot pour mot : « une coupure à n'importe quel
// geste laisse l'ancien état valide ou le nouveau, jamais ni l'un ni l'autre ». Trois constructions
// la donnent, et deux sont écartées ici :
//
//  - **fichier temporaire + renommage** suppose que le renommage soit atomique ET disponible. Sur
//    OPFS, `FileSystemFileHandle.move` n'est pas servi par les trois moteurs de la matrice #2, et
//    l'ADR 0016 a déjà refusé de faire reposer une atomicité sur DEUX fichiers là où un handle et
//    une barrière suffisent ;
//  - **journal d'intention** demande un troisième fichier voisin, ses règles de reprise, et son
//    propre format — pour un état qui tient en quatre kilo-octets ;
//  - **deux pages alternées dans un seul fichier**, qui est ce que l'ADR 0014 fait déjà pour la
//    racine de génération. Un écrivain écrit TOUJOURS la page qui ne fait pas autorité, franchit la
//    barrière, et c'est cette barrière qui publie le nouvel état. Une coupure ne peut donc abîmer
//    que la page qui ne faisait pas autorité.
//
// Le fichier est de taille FIXE, alloué en une fois à la création. Il n'est jamais tronqué ni
// agrandi : un fichier qui change de taille pendant une écriture offrirait un troisième état — ni
// l'ancien, ni le nouveau — que rien ne relirait.
//
// ## Pourquoi un CRC-32, alors que l'ADR 0016 l'a justement REMPLACÉ par une étiquette
//
// Parce que les deux ne répondent pas de la même question, et que la mesure l'a établi. L'ADR 0016
// retire le CRC de la racine de génération : là, une étiquette AES-GCM est vérifiable au même
// moment, et elle est strictement meilleure. Ici, elle ne l'est PAS : vérifier l'étiquette d'une
// racine d'enveloppe exige la DEK, qu'on ne peut obtenir qu'en développant un emplacement de la
// page — c'est-à-dire APRÈS avoir décidé que cette page est celle qu'il faut lire.
//
// Sans somme de contrôle, le lecteur ne sait donc pas distinguer une page COMPLÈTE d'une page
// DÉCHIRÉE, et le défaut n'est pas théorique : `vm-enveloppe-coupures.test.mjs` l'a produit en
// coupant une écriture à quarante octets. La page portait alors l'en-tête NEUF — version, compte —
// au-dessus de la liste ANCIENNE. Elle se décodait sans broncher, elle paraissait être l'état
// courant, et une clé légitime de l'état courant s'y voyait refusée sans repli sur l'état
// précédent : une coupure faisait perdre une clé. Le CRC-32 rend cette page structurellement
// invalide, donc écartée, donc suivie du repli qui la couvre.
//
// Ce qu'il ne fait pas est écrit aussi : il ne protège contre AUCUN adversaire. Qui peut écrire
// dans l'origine de confiance recalcule un CRC sans effort. Il sépare l'accident de l'écriture
// complète, exactement comme dans l'ADR 0014, et rien de plus.
//
// L'implémentation du polynôme est reprise ici plutôt qu'importée de `generation-v1-rejeu.mjs`, qui
// la garde privée. Douze lignes d'un polynôme normalisé valent mieux qu'un export ouvert dans un
// module que la tranche #19 est en train de modifier.
//
// ## Le prix de cette construction, écrit plutôt que découvert
//
// Une page abîmée est INDISCERNABLE d'une page volontairement ramenée à un état antérieur. Le
// lecteur retient la page valide de plus grande version ; si un adversaire remplace la page
// courante par n'importe quoi, le lecteur sert la précédente, et cette dégradation ressemble
// exactement à une reprise après coupure. C'est le prix de l'alternance, il est le même que celui
// de la racine de l'ADR 0014, et l'ADR 0020 le nomme au lieu de le laisser trouver.

import { hexEnOctets, octetsEnHex } from "../format-chiffre/octets.mjs";
import { malforme } from "./enveloppe-errors.mjs";
import {
  CLE_OCTETS,
  EMPLACEMENTS_MAX,
  EMPREINTE_OCTETS,
  ENVELOPPE_FORMAT_V1,
  ETIQUETTE_OCTETS,
  IDENTIFIANT_EMPLACEMENT_OCTETS,
  NONCE_OCTETS,
  PARAMETRES_MAX,
  VERSION_MAX,
  exigerOctets,
  exigerParametres,
  exigerTypeKek,
} from "./identite-enveloppe.mjs";

/** Marqueur du fichier d'enveloppes. Huit octets, jamais modifiés. */
export const MARQUEUR_ENVELOPPE = Uint8Array.from([0x56, 0x4c, 0x54, 0x4b, 0x45, 0x59, 0x30, 0x31]); // "VLTKEY01"

/** Taille d'UNE page, en octets : deux pages hôtes de 4096, l'unité de `generation-format.mjs`. */
export const PAGE_OCTETS = 8192;

/** Le fichier porte exactement DEUX pages, et sa taille ne change jamais. */
export const PAGES = 2;

/** Taille du fichier `<volume>.cles`. Fixe, allouée à la création. */
export const TAILLE_FICHIER_ENVELOPPE = PAGE_OCTETS * PAGES;

/** Longueur de l'en-tête d'une page, avant la liste des emplacements. */
export const ENTETE_PAGE_OCTETS = 108;

/** Où loge la somme de contrôle de la page. Elle est à ZÉRO pendant son propre calcul. */
export const CRC_OFFSET = 104;

const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let valeur = index;
    for (let bit = 0; bit < 8; bit += 1) {
      valeur = valeur & 1 ? (0xedb88320 ^ (valeur >>> 1)) >>> 0 : valeur >>> 1;
    }
    table[index] = valeur >>> 0;
  }
  return table;
})();

/** CRC-32 (polynôme 0xedb88320), sur les octets utiles d'une page : en-tête puis liste. */
function crc32(octets) {
  let valeur = 0xffffffff;
  for (let index = 0; index < octets.byteLength; index += 1) {
    valeur = (TABLE_CRC[(valeur ^ octets[index]) & 0xff] ^ (valeur >>> 8)) >>> 0;
  }
  return (valeur ^ 0xffffffff) >>> 0;
}

/**
 * Somme de contrôle des octets UTILES d'une page : l'en-tête, son champ de somme mis à zéro, puis
 * la liste déclarée. Le remplissage n'y entre pas — il est à zéro par construction, et l'y inclure
 * ferait dépendre la somme de huit kilo-octets pour rien.
 */
export function sommeDePage(octets, longueurListe) {
  const utiles = octets.slice(0, ENTETE_PAGE_OCTETS + longueurListe);
  utiles.fill(0, CRC_OFFSET, CRC_OFFSET + 4);
  return crc32(utiles);
}

/** Longueur de la partie FIXE d'un emplacement sur disque ; les paramètres la suivent. */
export const EMPLACEMENT_FIXE_OCTETS = 72;

/** Identifiant de volume sur disque : seize octets bruts, comme dans l'en-tête v3. */
const IDENTIFIANT_VOLUME_OCTETS = 16;

/** Offset de la page `index` dans le fichier. */
export function offsetDePage(index) {
  if (index !== 0 && index !== 1) {
    throw malforme(`une enveloppe porte ${PAGES} pages ; la page ${index} n'existe pas.`, {
      index,
    });
  }
  return index * PAGE_OCTETS;
}

function ecrireEntier(vue, position, valeur, octets) {
  if (!Number.isSafeInteger(valeur) || valeur < 0) {
    throw malforme(`${valeur} n'est pas un entier non négatif.`);
  }
  let reste = valeur;
  for (let index = 0; index < octets; index += 1) {
    vue.setUint8(position + index, reste % 256);
    reste = Math.floor(reste / 256);
  }
  if (reste !== 0) throw malforme(`${valeur} ne tient pas sur ${octets} octet(s).`);
}

function lireEntier(vue, position, octets) {
  let valeur = 0;
  for (let index = octets - 1; index >= 0; index -= 1) {
    valeur = valeur * 256 + vue.getUint8(position + index);
  }
  return valeur;
}

/** Octets d'UN emplacement sur disque : partie fixe puis paramètres. */
function encoderEmplacement(emplacement) {
  const { identifiantEmplacement, typeKek, parametres, nonce, dekEnveloppee, etiquette } =
    emplacement;
  exigerTypeKek(typeKek);
  exigerParametres(parametres);
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  exigerOctets("dekEnveloppee", dekEnveloppee, CLE_OCTETS);
  exigerOctets("etiquette", etiquette, ETIQUETTE_OCTETS);

  const octets = new Uint8Array(EMPLACEMENT_FIXE_OCTETS + parametres.byteLength);
  const vue = new DataView(octets.buffer);
  octets.set(hexEnOctets(identifiantEmplacement), 0);
  vue.setUint8(8, typeKek);
  vue.setUint8(9, 0);
  vue.setUint16(10, parametres.byteLength, true);
  octets.set(nonce, 12);
  octets.set(dekEnveloppee, 24);
  octets.set(etiquette, 56);
  octets.set(parametres, EMPLACEMENT_FIXE_OCTETS);
  return octets;
}

/**
 * Relit UN emplacement, ou rend `null` si les octets restants n'en portent pas un entier.
 *
 * Rien n'est complété ni arrondi : un emplacement dont les paramètres débordent la liste déclarée
 * n'est pas un emplacement plus court, c'est une liste qu'on ne sait pas lire.
 */
function decoderEmplacement(octets, position, fin) {
  if (fin - position < EMPLACEMENT_FIXE_OCTETS) return null;
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const longueurParametres = vue.getUint16(position + 10, true);
  if (longueurParametres > PARAMETRES_MAX) return null;
  const total = EMPLACEMENT_FIXE_OCTETS + longueurParametres;
  if (fin - position < total) return null;

  return {
    suivant: position + total,
    emplacement: Object.freeze({
      identifiantEmplacement: octetsEnHex(
        octets.slice(position, position + IDENTIFIANT_EMPLACEMENT_OCTETS),
      ),
      typeKek: vue.getUint8(position + 8),
      parametres: octets.slice(position + EMPLACEMENT_FIXE_OCTETS, position + total),
      nonce: octets.slice(position + 12, position + 24),
      dekEnveloppee: octets.slice(position + 24, position + 56),
      etiquette: octets.slice(position + 56, position + 72),
    }),
  };
}

/**
 * Encode une page complète : en-tête, racine scellée, liste ordonnée des emplacements, puis des
 * ZÉROS jusqu'à `PAGE_OCTETS`.
 *
 * Le remplissage est à zéro et non laissé tel quel : une page réécrite laisserait sinon voir la
 * queue de la précédente — c'est-à-dire un emplacement révoqué, encore lisible sur le disque, dont
 * la DEK enveloppée serait intacte. Une révocation qui laisserait ses octets derrière elle ne serait
 * pas une révocation.
 *
 * @param {{ identifiantVolume: string, version: number,
 *           racine: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           emplacements: Array<object> }} page
 * @returns {Uint8Array} exactement `PAGE_OCTETS` octets
 */
export function encoderPage({ identifiantVolume, version, racine, emplacements }) {
  if (!Array.isArray(emplacements) || emplacements.length === 0) {
    throw malforme("une page d'enveloppe porte au moins UN emplacement.");
  }
  if (emplacements.length > EMPLACEMENTS_MAX) {
    throw malforme(
      `une enveloppe porte au plus ${EMPLACEMENTS_MAX} emplacements, reçu ${emplacements.length}.`,
      { plafond: EMPLACEMENTS_MAX },
    );
  }
  if (!Number.isSafeInteger(version) || version < 1 || version > VERSION_MAX) {
    throw malforme(`« version » doit être un entier de 1 à ${VERSION_MAX}, reçu ${version}.`);
  }
  exigerOctets("racine.nonce", racine?.nonce, NONCE_OCTETS);
  exigerOctets("racine.chiffre", racine?.chiffre, EMPREINTE_OCTETS);
  exigerOctets("racine.etiquette", racine?.etiquette, ETIQUETTE_OCTETS);

  const liste = emplacements.map(encoderEmplacement);
  const longueurListe = liste.reduce((somme, octets) => somme + octets.byteLength, 0);
  if (ENTETE_PAGE_OCTETS + longueurListe > PAGE_OCTETS) {
    throw malforme(
      `la liste des emplacements fait ${longueurListe} octets et ne tient pas dans une page de ${PAGE_OCTETS}.`,
      { longueurListe, page: PAGE_OCTETS },
    );
  }

  const octets = new Uint8Array(PAGE_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MARQUEUR_ENVELOPPE, 0);
  vue.setUint32(8, ENVELOPPE_FORMAT_V1, true);
  vue.setUint16(12, emplacements.length, true);
  ecrireEntier(vue, 16, version, 8);
  octets.set(hexEnOctets(identifiantVolume), 24);
  vue.setUint32(40, longueurListe, true);
  octets.set(racine.nonce, 44);
  octets.set(racine.chiffre, 56);
  octets.set(racine.etiquette, 88);
  let curseur = ENTETE_PAGE_OCTETS;
  for (const morceau of liste) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  vue.setUint32(CRC_OFFSET, sommeDePage(octets, longueurListe), true);
  return octets;
}

function marqueurPresent(octets) {
  return MARQUEUR_ENVELOPPE.every((attendu, position) => octets[position] === attendu);
}

/** Refus structurel d'une page. Rien n'est levé : une page invalide est un FAIT, pas un incident. */
const refus = (raison) => Object.freeze({ valide: false, raison, page: null });

/**
 * Relit une page. Tout doute est un refus, jamais une lecture « probablement bonne ».
 *
 * La fonction ne LÈVE pas : les deux pages sont relues à chaque ouverture, et l'une d'elles est
 * normalement invalide — c'est le cas ordinaire après une coupure. Un refus est donc un résultat que
 * l'appelant compare, pas une exception qu'il rattrape.
 *
 * @param {Uint8Array} octets une page entière
 * @returns {{ valide: boolean, raison: string | null, page: object | null }}
 */
export function decoderPage(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < PAGE_OCTETS) {
    return refus(`Page trop courte : ${octets?.byteLength ?? "aucun"} octet(s).`);
  }
  if (!marqueurPresent(octets)) return refus("Marqueur d'enveloppe absent.");

  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const formatVersion = vue.getUint32(8, true);
  if (formatVersion !== ENVELOPPE_FORMAT_V1) {
    return refus(`Format d'enveloppe inconnu : ${formatVersion}.`);
  }
  const nombreEmplacements = vue.getUint16(12, true);
  if (nombreEmplacements === 0 || nombreEmplacements > EMPLACEMENTS_MAX) {
    return refus(`Nombre d'emplacements inadmissible : ${nombreEmplacements}.`);
  }
  const version = lireEntier(vue, 16, 8);
  if (version < 1) return refus("Compteur de version nul : une enveloppe créée porte au moins 1.");
  const longueurListe = vue.getUint32(40, true);
  if (ENTETE_PAGE_OCTETS + longueurListe > PAGE_OCTETS) {
    return refus(`Liste de ${longueurListe} octets annoncée hors de la page.`);
  }
  // La somme de contrôle sépare une page COMPLÈTE d'une page DÉCHIRÉE, et rien d'autre : voir
  // l'en-tête de ce fichier. Une page qui ne la vérifie pas n'est pas un état, c'est un reste.
  if (sommeDePage(octets, longueurListe) !== vue.getUint32(CRC_OFFSET, true)) {
    return refus("Somme de contrôle de page invalide : écriture incomplète ou octets abîmés.");
  }

  const emplacements = decoderListe(octets, longueurListe);
  if (emplacements === null) return refus("Liste d'emplacements illisible ou tronquée.");

  return Object.freeze({
    valide: true,
    raison: null,
    page: Object.freeze({
      formatVersion,
      version,
      identifiantVolume: octetsEnHex(octets.slice(24, 24 + IDENTIFIANT_VOLUME_OCTETS)),
      // Le compte AUTHENTIFIÉ vient d'ici ; le compte TROUVÉ vient de la liste. Les garder
      // distincts est ce qui permet à `ouvrirRacine` de classer une troncature.
      nombreEmplacements,
      racine: Object.freeze({
        nonce: octets.slice(44, 56),
        chiffre: octets.slice(56, 88),
        etiquette: octets.slice(88, 104),
      }),
      emplacements: Object.freeze(emplacements),
    }),
  });
}

/** Relit la liste entière, ou `null` si elle ne se décompose pas exactement. */
function decoderListe(octets, longueurListe) {
  const fin = ENTETE_PAGE_OCTETS + longueurListe;
  const emplacements = [];
  let curseur = ENTETE_PAGE_OCTETS;
  while (curseur < fin) {
    if (emplacements.length >= EMPLACEMENTS_MAX) return null;
    const lu = decoderEmplacement(octets, curseur, fin);
    if (lu === null) return null;
    emplacements.push(lu.emplacement);
    curseur = lu.suivant;
  }
  // Une liste qui ne retombe pas EXACTEMENT sur sa fin déclarée n'est pas une liste plus courte.
  return curseur === fin ? emplacements : null;
}
