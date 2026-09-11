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
  DOMAINES_DE_RACINE,
  EMPLACEMENTS_MAX,
  EMPREINTE_OCTETS,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  ETIQUETTE_OCTETS,
  IDENTIFIANT_EMPLACEMENT_OCTETS,
  NONCE_OCTETS,
  PARAMETRES_MAX,
  SEL_DE_PAGE_OCTETS,
  VERSION_MAX,
  exigerOctets,
  exigerParametres,
  exigerOctetDeTypeKek,
  nomDuDomaineDeRacine,
} from "./identite-enveloppe.mjs";

/** Marqueur du fichier d'enveloppes. Huit octets, jamais modifiés. */
export const MARQUEUR_ENVELOPPE = Uint8Array.from([0x56, 0x4c, 0x54, 0x4b, 0x45, 0x59, 0x30, 0x31]); // "VLTKEY01"

/** Taille d'UNE page, en octets : deux pages hôtes de 4096, l'unité de `generation-format.mjs`. */
export const PAGE_OCTETS = 8192;

/** Le fichier porte exactement DEUX pages, et sa taille ne change jamais. */
export const PAGES = 2;

/** Taille du fichier `<volume>.cles`. Fixe, allouée à la création. */
export const TAILLE_FICHIER_ENVELOPPE = PAGE_OCTETS * PAGES;

/**
 * Les DISPOSITIONS d'en-tête, par version de page.
 *
 * La v2 n'a RIEN déplacé : elle AJOUTE le sel de trente-deux octets là où la v1 s'arrêtait, et
 * repousse la somme de contrôle derrière lui. Tous les offsets antérieurs — marqueur, version,
 * compte, identifiant, longueur de liste, nonce, chiffré et étiquette de racine — sont les mêmes à
 * l'octet près. C'est ce qui permet à la migration de page de relire une v1 avec le même décodeur,
 * et aux vecteurs figés de #21 de ne pas bouger.
 *
 * L'octet 14 porte le DOMAINE de la racine en v2. Il est à zéro dans toute page v1 — c'était un
 * octet de remplissage —, ce qui rend le champ inoffensif pour les pages déjà écrites.
 *
 *     [ 0   marqueur (8) ][ 8  version de format (4) ][ 12 compte (2) ][ 14 domaine (1) ][ 15 nul ]
 *     [ 16  version de page (8) ][ 24 identifiant de volume (16) ][ 40 longueur de liste (4) ]
 *     [ 44  nonce de racine (12) ][ 56 chiffré (32) ][ 88 étiquette (16) ]
 *     v1 :                                                        [ 104 somme (4) ] → 108
 *     v2 : [ 104 sel (32) ]                                       [ 136 somme (4) ] → 140
 */
const DISPOSITIONS_DE_PAGE = Object.freeze({
  [ENVELOPPE_FORMAT_V1]: Object.freeze({ selOffset: null, crcOffset: 104, entete: 108 }),
  [ENVELOPPE_FORMAT_V2]: Object.freeze({ selOffset: 104, crcOffset: 136, entete: 140 }),
});

/** Où loge le DOMAINE de la racine, en v2 : un octet, à zéro dans toute page v1. */
export const DOMAINE_OFFSET = 14;

/**
 * Longueur de l'en-tête d'une page, avant la liste des emplacements.
 *
 * Le nom nu désigne la v1, et il reste : `tests/unit/vm-enveloppe-vecteurs.test.mjs` et les outils
 * de `tools/figer-vecteurs-*.mjs` l'emploient pour composer des pages v1 à la main, et ces
 * documents ne bougent pas. Le chemin de production passe par `dispositionDePage`.
 */
export const ENTETE_PAGE_OCTETS = DISPOSITIONS_DE_PAGE[ENVELOPPE_FORMAT_V1].entete;

/** Où loge la somme de contrôle d'une page v1. Elle est à ZÉRO pendant son propre calcul. */
export const CRC_OFFSET = DISPOSITIONS_DE_PAGE[ENVELOPPE_FORMAT_V1].crcOffset;

/** Longueur de l'en-tête d'une page v2, sel compris. */
export const ENTETE_PAGE_V2_OCTETS = DISPOSITIONS_DE_PAGE[ENVELOPPE_FORMAT_V2].entete;

/**
 * La disposition d'une version de page, ou un refus TYPÉ.
 *
 * Une version inconnue n'est pas une page plus courte : c'est une page qu'on ne sait pas lire, et le
 * décodeur la traite comme telle.
 */
export function dispositionDePage(formatVersion) {
  const disposition = DISPOSITIONS_DE_PAGE[formatVersion];
  if (disposition === undefined) {
    throw malforme(`Format d'enveloppe inconnu : ${formatVersion}.`, { formatVersion });
  }
  return disposition;
}

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
export function sommeDePage(octets, longueurListe, formatVersion = ENVELOPPE_FORMAT_V1) {
  const { entete, crcOffset } = dispositionDePage(formatVersion);
  const utiles = octets.slice(0, entete + longueurListe);
  utiles.fill(0, crcOffset, crcOffset + 4);
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
  exigerOctetDeTypeKek(typeKek);
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
 * ## Ce que la version 2 ajoute, et ce qu'elle coûte à la page — MESURÉ
 *
 * Deux champs : le SEL de trente-deux octets, tiré et écrit en clair, et l'octet de DOMAINE. L'en-
 * tête passe de 108 à 140 octets. La question que l'ADR 0033 posait dans ses « Risques » — « cela
 * peut coûter un emplacement dans le pire cas » — se répond par un calcul, et la réponse est NON :
 *
 *     pire cas de liste = 8 emplacements × (72 octets fixes + 512 de paramètres) = 4 672 octets
 *     en-tête v2 + pire cas                                     = 140 + 4 672  = 4 812 octets
 *     page                                                                      = 8 192 octets
 *
 * Il reste 3 380 octets, soit de quoi porter cinq emplacements de plus au pire tarif. Le sel ne
 * coûte AUCUN emplacement, et il n'en coûterait un que si le plafond passait de huit à quatorze.
 * `tests/unit/vm-enveloppe-page-v2.test.mjs` le mesure plutôt que de le supposer.
 *
 * @param {{ identifiantVolume: string, version: number, formatVersion?: number,
 *           racine: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           sel?: Uint8Array, domaine?: number, emplacements: Array<object> }} page
 *   `formatVersion` vaut `ENVELOPPE_FORMAT_V1` par défaut : les outils qui figent les vecteurs de
 *   #21 composent des pages v1 et ne changent pas. Le produit, lui, écrit toujours une v2.
 * @returns {Uint8Array} exactement `PAGE_OCTETS` octets
 */
export function encoderPage({
  identifiantVolume,
  version,
  formatVersion = ENVELOPPE_FORMAT_V1,
  racine,
  sel = null,
  domaine = DOMAINES_DE_RACINE.enveloppe,
  emplacements,
}) {
  const disposition = dispositionDePage(formatVersion);
  exigerPageEncodable({ formatVersion, disposition, sel, domaine, version, racine, emplacements });

  const liste = emplacements.map(encoderEmplacement);
  const longueurListe = liste.reduce((somme, octets) => somme + octets.byteLength, 0);
  if (disposition.entete + longueurListe > PAGE_OCTETS) {
    throw malforme(
      `la liste des emplacements fait ${longueurListe} octets et ne tient pas dans une page de ${PAGE_OCTETS}.`,
      { longueurListe, page: PAGE_OCTETS },
    );
  }

  const octets = new Uint8Array(PAGE_OCTETS);
  const vue = new DataView(octets.buffer);
  ecrireEnteteDePage(octets, vue, {
    disposition,
    formatVersion,
    identifiantVolume,
    version,
    racine,
    sel,
    domaine,
    nombreEmplacements: emplacements.length,
    longueurListe,
  });
  let curseur = disposition.entete;
  for (const morceau of liste) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  vue.setUint32(disposition.crcOffset, sommeDePage(octets, longueurListe, formatVersion), true);
  return octets;
}

/**
 * REFUSE tout ce qui ne peut pas devenir une page, AVANT qu'un seul octet ne soit posé.
 *
 * Les contrôles vivent ensemble parce qu'ils répondent tous d'une même question — « ces valeurs
 * décrivent-elles une page ? » — et parce que les séparer de l'écriture est ce qui rend
 * `encoderPage` lisible d'un œil : un refus, puis une transcription.
 */
function exigerPageEncodable({
  formatVersion,
  disposition,
  sel,
  domaine,
  version,
  racine,
  emplacements,
}) {
  exigerSelDeLaVersion(formatVersion, disposition, sel);
  if (formatVersion === ENVELOPPE_FORMAT_V2 && nomDuDomaineDeRacine(domaine) === null) {
    throw malforme(
      `« domaine » vaut ${domaine}, qui ne désigne aucun domaine de racine (${Object.keys(DOMAINES_DE_RACINE).join(", ")}).`,
      { domaine },
    );
  }
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
}

/** TRANSCRIT l'en-tête d'une page, champ par champ, aux offsets que la disposition impose. */
function ecrireEnteteDePage(
  octets,
  vue,
  {
    disposition,
    formatVersion,
    identifiantVolume,
    version,
    racine,
    sel,
    domaine,
    nombreEmplacements,
    longueurListe,
  },
) {
  octets.set(MARQUEUR_ENVELOPPE, 0);
  vue.setUint32(8, formatVersion, true);
  vue.setUint16(12, nombreEmplacements, true);
  if (disposition.selOffset !== null) {
    vue.setUint8(DOMAINE_OFFSET, domaine);
    octets.set(sel, disposition.selOffset);
  }
  ecrireEntier(vue, 16, version, 8);
  octets.set(hexEnOctets(identifiantVolume), 24);
  vue.setUint32(40, longueurListe, true);
  octets.set(racine.nonce, 44);
  octets.set(racine.chiffre, 56);
  octets.set(racine.etiquette, 88);
}

/**
 * EXIGE le sel que la version demande : aucun en v1, trente-deux octets en v2.
 *
 * Le refus est symétrique, et c'est le point : un sel présenté pour une page v1 serait écrit nulle
 * part et l'appelant croirait avoir tiré une clé fraîche ; un sel absent d'une page v2 rendrait la
 * même clé pour toutes les pages d'un volume, c'est-à-dire le régime que la décision 4 de
 * l'ADR 0033 refuse.
 */
function exigerSelDeLaVersion(formatVersion, disposition, sel) {
  if (disposition.selOffset === null) {
    if (sel === null) return;
    throw malforme(
      `une page en version ${formatVersion} ne porte pas de sel ; trente-deux octets ont été présentés, et ils ne seraient écrits nulle part.`,
      { formatVersion },
    );
  }
  exigerOctets("sel", sel, SEL_DE_PAGE_OCTETS);
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
  const entete = relireEnteteDePage(octets, vue);
  if (entete.raison !== null) return refus(entete.raison);
  const { disposition, formatVersion, nombreEmplacements, version, longueurListe, domaine } =
    entete;

  const emplacements = decoderListe(octets, longueurListe, disposition.entete);
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
      // Le SEL et le DOMAINE sont `null` sur une page v1 : elle n'en porte pas, et son lecteur le
      // sait. Les rendre à zéro ferait croire à un sel constant.
      sel:
        disposition.selOffset === null
          ? null
          : octets.slice(disposition.selOffset, disposition.selOffset + SEL_DE_PAGE_OCTETS),
      domaine,
      racine: Object.freeze({
        nonce: octets.slice(44, 56),
        chiffre: octets.slice(56, 88),
        etiquette: octets.slice(88, 104),
      }),
      emplacements: Object.freeze(emplacements),
    }),
  });
}

/**
 * RELIT l'en-tête d'une page et REFUSE tout ce qui ne peut pas en être un, somme de contrôle
 * comprise. Rend `{ raison }` non nulle au premier doute — jamais une lecture « probablement bonne ».
 *
 * L'ORDRE compte, et il est celui-ci : la VERSION de format d'abord, puisqu'elle décide de la
 * disposition ; puis les champs de largeur fixe ; puis le DOMAINE, refusé s'il ne désigne rien —
 * une page dont on ne sait pas sous quelle clé la racine est scellée n'est pas une page qu'on lira
 * « au mieux » ; puis la SOMME, qui sépare une page complète d'une page déchirée, et rien d'autre.
 */
function relireEnteteDePage(octets, vue) {
  const refuse = (raison) => ({ raison });
  const formatVersion = vue.getUint32(8, true);
  const disposition = DISPOSITIONS_DE_PAGE[formatVersion];
  if (disposition === undefined) return refuse(`Format d'enveloppe inconnu : ${formatVersion}.`);

  const nombreEmplacements = vue.getUint16(12, true);
  if (nombreEmplacements === 0 || nombreEmplacements > EMPLACEMENTS_MAX) {
    return refuse(`Nombre d'emplacements inadmissible : ${nombreEmplacements}.`);
  }
  const version = lireEntier(vue, 16, 8);
  if (version < 1) return refuse("Compteur de version nul : une enveloppe créée porte au moins 1.");
  const longueurListe = vue.getUint32(40, true);
  if (disposition.entete + longueurListe > PAGE_OCTETS) {
    return refuse(`Liste de ${longueurListe} octets annoncée hors de la page.`);
  }
  // La v1 ne porte pas de domaine — son octet 14 est du remplissage, et il vaut zéro.
  const domaine = disposition.selOffset === null ? null : vue.getUint8(DOMAINE_OFFSET);
  if (domaine !== null && nomDuDomaineDeRacine(domaine) === null) {
    return refuse(`Domaine de racine inconnu : ${domaine}.`);
  }
  if (
    sommeDePage(octets, longueurListe, formatVersion) !== vue.getUint32(disposition.crcOffset, true)
  ) {
    return refuse("Somme de contrôle de page invalide : écriture incomplète ou octets abîmés.");
  }
  return {
    raison: null,
    disposition,
    formatVersion,
    nombreEmplacements,
    version,
    longueurListe,
    domaine,
  };
}

/** Relit la liste entière, ou `null` si elle ne se décompose pas exactement. */
function decoderListe(octets, longueurListe, entete = ENTETE_PAGE_OCTETS) {
  const fin = entete + longueurListe;
  const emplacements = [];
  let curseur = entete;
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
