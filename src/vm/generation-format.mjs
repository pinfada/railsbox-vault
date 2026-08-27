// Format du journal de génération (#16, ADR 0014).
//
// Une génération est l'ensemble des écritures comprises entre deux barrières acquittées. Elle est
// déposée dans un fichier VOISIN du volume — `<volume>.gen` — puis VALIDÉE par l'écriture d'une
// RACINE : un seul secteur, qui nomme la génération et scelle la charge.
//
// Deux propriétés gouvernent tout ce fichier.
//
//  - **La commutation tient dans une écriture d'un seul secteur.** `RACINE_OCTETS` vaut 512, la plus
//    petite unité que le matériel émulé adresse. L'atomicité sectorielle du support n'est pas
//    SUPPOSÉE pour autant : la racine porte l'ÉTIQUETTE de son propre en-tête, si bien qu'une racine
//    écrite à moitié est DÉTECTÉE et refusée. C'est une hypothèse écrite, et éprouvée par
//    `tests/unit/vm-generation-format.test.mjs`, pas une hypothèse subie.
//  - **Les racines ALTERNENT.** Chaque écriture de racine porte un numéro de SÉQUENCE monotone et
//    occupe l'emplacement `sequence % RACINES`. Une validation interrompue ne peut donc PAS détruire
//    la racine qui fait autorité — ce qui serait la perte d'une écriture acquittée, c'est-à-dire une
//    violation de `SEC-DURABLE-001`. « Pas », et non « jamais » : la propriété repose sur une
//    hypothèse, écrite dans l'ADR 0014 — deux PAGES HÔTES distinctes ne sont pas abîmées ensemble.
//    C'est pourquoi les deux emplacements sont séparés par `PAGE_HOTE_OCTETS`, et non par un secteur.
//
// ## Le format v3 (#18, ADR 0016) : le CRC-32 a cédé la place à une ÉTIQUETTE
//
// L'ADR 0014 disait de sa somme de contrôle qu'elle « ne prétend RIEN contre un altérateur
// volontaire, qui la recalculerait sans difficulté », et qu'elle laissait la place à
// `SEC-BLOCK-001`. #18 la prend. Trois changements, tous décidés par l'ADR 0016 :
//
//  - **le format du journal passe de 1 à 2.** C'est la barrière de version : un runtime qui ne
//    connaît que v1 refuse cette racine par « Format de journal de génération inconnu », sans avoir
//    à comprendre ce qui a changé ;
//  - **la racine passe de 60 à 136 octets** dans le MÊME secteur, et son CRC-32 est remplacé par le
//    nonce, le chiffré (l'empreinte scellée des entrées) et l'étiquette. Recalculer exige désormais
//    la clé ;
//  - **un enregistrement porte un SCEAU de 34 octets** entre son en-tête et sa charge — la même
//    forme que la région d'authentification du volume, génération comprise. L'ADR 0015 en annonçait
//    28 en supposant que la génération d'un enregistrement était celle de sa racine ; l'ADR 0016
//    montre que c'est faux, puisque le journal n'est vidé qu'au point de contrôle et qu'une charge
//    porte donc plusieurs générations.
//
// La **longueur de charge** que la racine authentifie est celle des CLAIRS (ADR 0015,
// `enteteDeRacine`). La longueur PHYSIQUE de la charge s'en déduit — `longueurCharge +
// nombreEntrees × SURCOUT_ENREGISTREMENT` — plutôt que d'être stockée : deux grandeurs stockées
// peuvent diverger, une grandeur dérivée ne le peut pas.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import {
  EMPREINTE_OCTETS,
  ETIQUETTE_OCTETS,
  IDENTIFIANT_VOLUME_OCTETS,
  NONCE_OCTETS,
} from "./format-chiffre/identite-logique.mjs";
import { SCEAU_OCTETS } from "./volume-chiffre-format.mjs";

/** Marqueur d'une racine de génération. Huit octets, jamais modifiés. */
const MAGIC = Uint8Array.from([0x56, 0x4c, 0x54, 0x47, 0x45, 0x4e, 0x30, 0x31]); // "VLTGEN01"

/**
 * Version du format du journal de génération. Distincte du format du manifeste (#10).
 *
 * **2 depuis #18** : la racine est scellée, plus sommée. Un runtime antérieur la refuse comme un
 * format inconnu, ce qui est exactement le comportement voulu — il n'a pas la clé, et il écrirait en
 * clair dans un volume chiffré.
 */
export const GENERATION_FORMAT = 2;

/** Une racine occupe un secteur entier : c'est l'unité de la commutation. */
export const RACINE_OCTETS = SECTOR_SIZE;

/** Nombre de racines. Deux suffisent : valider n'écrase jamais la racine qui fait autorité. */
export const RACINES = 2;

/**
 * Octets qu'occupe une racine v3 dans son secteur : 136 sur 512. Le détail est dans l'ADR 0016.
 *
 * marqueur 8 + format 4 + secteur 4 + séquence 8 + génération 8 + taille du volume 8 + nombre
 * d'entrées 4 + longueur de charge 8 + identifiant de volume 16 + scellements cumulés 8 + nonce 12
 * + chiffré 32 + étiquette 16.
 */
export const RACINE_ENTETE_OCTETS = 136;

/** Sceau d'un enregistrement : la MÊME forme que celle de la région du volume (ADR 0016). */
export const SCEAU_ENREGISTREMENT_OCTETS = SCEAU_OCTETS;

/**
 * ÉCART entre deux emplacements de racine. Une page hôte, pas un secteur.
 *
 * La raison est une exigence de cohérence, relevée en revue de #90. Ce format REFUSE de supposer
 * l'atomicité sectorielle — la racine porte l'étiquette de son propre en-tête, précisément
 * pour qu'une écriture déchirée soit détectée. Placer les deux racines dans la même page de 4 Kio
 * reviendrait alors à supposer gratuitement une propriété du même ordre : qu'une écriture qui abîme
 * un secteur ne peut pas abîmer son voisin immédiat. Rien ne le garantit — un support qui réécrit
 * une page entière pour modifier un secteur les emporte tous les deux.
 *
 * Les écarter d'une page ne PROUVE rien non plus : l'hypothèse devient « deux pages distinctes ne
 * tombent pas ensemble », et elle est ÉCRITE dans l'ADR 0014 au lieu d'être subie. C'est pourquoi
 * l'alternance des racines se dit « ne peut PAS détruire, sous cette hypothèse » et non « ne peut
 * JAMAIS détruire ».
 */
export const PAGE_HOTE_OCTETS = 4096;

/** Premier octet de la zone des enregistrements, après les deux racines. */
export const ZONE_ENREGISTREMENTS = RACINES * PAGE_HOTE_OCTETS;

/** En-tête d'un enregistrement : offset logique sur 64 bits, longueur sur 32, réserve sur 32. */
export const ENTETE_OCTETS = 16;

/**
 * Surcoût FIXE d'un enregistrement sur le support : son en-tête et son sceau.
 *
 * Il est fixe, et c'est ce qui permet de dériver la longueur PHYSIQUE d'une charge de ce que la
 * racine authentifie — le nombre d'entrées et la longueur des clairs — au lieu de la stocker.
 */
export const SURCOUT_ENREGISTREMENT = ENTETE_OCTETS + SCEAU_ENREGISTREMENT_OCTETS;

/** Emplacement de la racine de rang `rang`. Une PAGE HÔTE les sépare, pas un secteur. */
export function offsetDeRacine(rang) {
  return rang * PAGE_HOTE_OCTETS;
}

/** Emplacement qu'occupe la racine de séquence `sequence`. L'alternance protège la précédente. */
export function racineDeSequence(sequence) {
  return sequence % RACINES;
}

function ecrireEntier64(vue, position, valeur) {
  if (!Number.isSafeInteger(valeur) || valeur < 0) {
    throw new RangeError(`Entier non représentable dans une racine de génération : ${valeur}.`);
  }
  vue.setUint32(position, valeur >>> 0, true);
  vue.setUint32(position + 4, Math.floor(valeur / 2 ** 32), true);
}

function lireEntier64(vue, position) {
  return vue.getUint32(position, true) + vue.getUint32(position + 4, true) * 2 ** 32;
}

/** Longueur PHYSIQUE d'une charge, dérivée de ce que la racine authentifie. Jamais stockée. */
export function longueurPhysiqueDeCharge({ nombreEntrees, longueurCharge }) {
  return longueurCharge + nombreEntrees * SURCOUT_ENREGISTREMENT;
}

/**
 * Encode une racine SCELLÉE dans un secteur complet.
 *
 * Les champs d'en-tête et le sceau sont écrits ensemble mais ne jouent pas le même rôle : les
 * premiers sont les DONNÉES ASSOCIÉES que le scellement authentifie (sauf marqueur, format et
 * taille de secteur, qui localisent et n'autorisent pas), le second est le verdict. L'appelant a
 * déjà scellé ; ce module ne fait qu'écrire.
 *
 * @param {{ sequence: number, generation: number, tailleVolume: number, nombreEntrees: number,
 *           longueurCharge: number, identifiantVolume: Uint8Array, scellementsCumules: number,
 *           nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array }} racine
 * @returns {Uint8Array} exactement `RACINE_OCTETS` octets
 */
export function encoderRacine({
  sequence,
  generation,
  tailleVolume,
  nombreEntrees,
  longueurCharge,
  identifiantVolume,
  scellementsCumules,
  nonce,
  chiffre,
  etiquette,
}) {
  exigerOctets("identifiantVolume", identifiantVolume, IDENTIFIANT_VOLUME_OCTETS);
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  exigerOctets("chiffre", chiffre, EMPREINTE_OCTETS);
  exigerOctets("etiquette", etiquette, ETIQUETTE_OCTETS);

  const octets = new Uint8Array(RACINE_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MAGIC, 0);
  vue.setUint32(8, GENERATION_FORMAT, true);
  vue.setUint32(12, SECTOR_SIZE, true);
  ecrireEntier64(vue, 16, sequence);
  ecrireEntier64(vue, 24, generation);
  ecrireEntier64(vue, 32, tailleVolume);
  vue.setUint32(40, nombreEntrees, true);
  ecrireEntier64(vue, 44, longueurCharge);
  octets.set(identifiantVolume, 52);
  ecrireEntier64(vue, 68, scellementsCumules);
  octets.set(nonce, 76);
  octets.set(chiffre, 88);
  octets.set(etiquette, 120);
  return octets;
}

function exigerOctets(nom, valeur, longueur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== longueur) {
    throw new RangeError(`« ${nom} » d'une racine fait ${longueur} octets.`);
  }
  return valeur;
}

function magicPresent(octets) {
  return MAGIC.every((attendu, position) => octets[position] === attendu);
}

function secteurVierge(octets) {
  for (let index = 0; index < RACINE_ENTETE_OCTETS; index += 1) {
    if (octets[index] !== 0) return false;
  }
  return true;
}

/**
 * Relit une racine, sans rien vérifier de cryptographique.
 *
 * **Ce que ce module rend est une racine PLAUSIBLE, jamais une racine AUTHENTIQUE.** Il refuse ce
 * qu'on peut refuser sans clé — secteur vierge, marqueur absent, format inconnu, autre taille de
 * secteur, autre taille de volume — et rend le sceau à l'appelant, à qui il revient de le
 * présenter à `ouvrirRacine`. La distinction est celle de l'ADR 0015 : classer avant d'avoir
 * vérifié l'étiquette serait deviner.
 *
 * @param {Uint8Array} octets un secteur relu du journal
 * @param {{ tailleVolume: number }} attentes
 * @returns {{ valide: boolean, vierge: boolean, racine: object | null, raison: string | null }}
 */
export function decoderRacine(octets, { tailleVolume }) {
  const refus = (raison, vierge = false) => ({ valide: false, vierge, racine: null, raison });
  if (!(octets instanceof Uint8Array) || octets.byteLength < RACINE_ENTETE_OCTETS) {
    return refus("Secteur de racine trop court pour porter un en-tête.");
  }
  if (secteurVierge(octets)) {
    return refus("Secteur vierge : aucune racine n'y a jamais été écrite.", true);
  }
  if (!magicPresent(octets)) return refus("Marqueur de racine absent.");

  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const format = vue.getUint32(8, true);
  if (format !== GENERATION_FORMAT) {
    return refus(`Format de journal de génération inconnu : ${format}.`);
  }
  if (vue.getUint32(12, true) !== SECTOR_SIZE) {
    return refus("Racine écrite avec une autre taille de secteur.");
  }
  const declaree = lireEntier64(vue, 32);
  if (declaree !== tailleVolume) {
    return refus(
      `Racine écrite pour un volume de ${declaree} octets, présenté avec une taille de ${tailleVolume}.`,
    );
  }
  return {
    valide: true,
    vierge: false,
    raison: null,
    racine: Object.freeze({
      format,
      sequence: lireEntier64(vue, 16),
      generation: lireEntier64(vue, 24),
      tailleVolume: declaree,
      nombreEntrees: vue.getUint32(40, true),
      longueurCharge: lireEntier64(vue, 44),
      identifiantVolume: octets.slice(52, 52 + IDENTIFIANT_VOLUME_OCTETS),
      scellementsCumules: lireEntier64(vue, 68),
      scelle: Object.freeze({
        nonce: octets.slice(76, 76 + NONCE_OCTETS),
        chiffre: octets.slice(88, 88 + EMPREINTE_OCTETS),
        etiquette: octets.slice(120, 120 + ETIQUETTE_OCTETS),
      }),
    }),
  };
}

/**
 * En-tête d'un enregistrement du journal : où ces octets iront dans le volume, et combien.
 * @param {{ offset: number, longueur: number }} entree
 */
export function encoderEnteteEnregistrement({ offset, longueur }) {
  const octets = new Uint8Array(ENTETE_OCTETS);
  const vue = new DataView(octets.buffer);
  ecrireEntier64(vue, 0, offset);
  vue.setUint32(8, longueur, true);
  vue.setUint32(12, 0, true);
  return octets;
}

/** Relit un en-tête d'enregistrement. Rend `null` si les champs sont hors de tout volume plausible. */
export function decoderEnteteEnregistrement(octets, { tailleVolume }) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < ENTETE_OCTETS) return null;
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const offset = lireEntier64(vue, 0);
  const longueur = vue.getUint32(8, true);
  if (longueur === 0 || offset + longueur > tailleVolume) return null;
  return Object.freeze({ offset, longueur });
}
