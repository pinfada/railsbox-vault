// Format du journal de génération (#16, ADR 0014).
//
// Une génération est l'ensemble des écritures comprises entre deux barrières acquittées. Elle est
// déposée dans un fichier VOISIN du volume — `<volume>.gen` — puis VALIDÉE par l'écriture d'une
// RACINE : un seul secteur, qui nomme la génération et scelle la charge par une somme de contrôle.
//
// Deux propriétés gouvernent tout ce fichier.
//
//  - **La commutation tient dans une écriture d'un seul secteur.** `RACINE_OCTETS` vaut 512, la plus
//    petite unité que le matériel émulé adresse. L'atomicité sectorielle du support n'est pas
//    SUPPOSÉE pour autant : la racine porte la somme de contrôle de son propre en-tête, si bien
//    qu'une racine écrite à moitié est DÉTECTÉE et refusée. C'est une hypothèse écrite, et éprouvée
//    par `tests/unit/vm-generation-format.test.mjs`, pas une hypothèse subie.
//  - **Les racines ALTERNENT.** Chaque écriture de racine porte un numéro de SÉQUENCE monotone et
//    occupe l'emplacement `sequence % RACINES`. Une validation interrompue ne peut donc PAS détruire
//    la racine qui fait autorité — ce qui serait la perte d'une écriture acquittée, c'est-à-dire une
//    violation de `SEC-DURABLE-001`. « Pas », et non « jamais » : la propriété repose sur une
//    hypothèse, écrite dans l'ADR 0014 — deux PAGES HÔTES distinctes ne sont pas abîmées ensemble.
//    C'est pourquoi les deux emplacements sont séparés par `PAGE_HOTE_OCTETS`, et non par un secteur.
//
// La somme de contrôle est un CRC-32 (polynôme IEEE 802.3 réfléchi). Elle détecte la DÉCHIRURE et
// l'octet retourné ; elle ne prétend RIEN contre un altérateur volontaire, qui la recalculerait sans
// difficulté. L'authentification d'un bloc et le refus de rejeu sont `SEC-BLOCK-001` et
// `SEC-GEN-001`, au jalon 4 (#18, #19) ; ce format leur laisse la place et ne la prend pas.

import { SECTOR_SIZE } from "./block-geometry.mjs";

/** Marqueur d'une racine de génération. Huit octets, jamais modifiés. */
const MAGIC = Uint8Array.from([0x56, 0x4c, 0x54, 0x47, 0x45, 0x4e, 0x30, 0x31]); // "VLTGEN01"

/** Version du format du journal de génération. Distincte du format du manifeste (#10). */
export const GENERATION_FORMAT = 1;

/** Une racine occupe un secteur entier : c'est l'unité de la commutation. */
export const RACINE_OCTETS = SECTOR_SIZE;

/** Nombre de racines. Deux suffisent : valider n'écrase jamais la racine qui fait autorité. */
export const RACINES = 2;

/** Octets de la racine couverts par la somme de contrôle de l'en-tête. */
export const RACINE_ENTETE_OCTETS = 60;

/**
 * ÉCART entre deux emplacements de racine. Une page hôte, pas un secteur.
 *
 * La raison est une exigence de cohérence, relevée en revue de #90. Ce format REFUSE de supposer
 * l'atomicité sectorielle — la racine porte la somme de contrôle de son propre en-tête, précisément
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

const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let octet = 0; octet < 256; octet += 1) {
    let valeur = octet;
    for (let bit = 0; bit < 8; bit += 1) {
      valeur = valeur & 1 ? 0xedb88320 ^ (valeur >>> 1) : valeur >>> 1;
    }
    table[octet] = valeur >>> 0;
  }
  return table;
})();

/**
 * CRC-32 des octets, poursuivant éventuellement une somme déjà commencée.
 *
 * L'appel incrémental n'est pas une commodité : la charge du journal grandit d'une génération à
 * l'autre, et recalculer la somme depuis le début à chaque barrière ferait payer à la dixième
 * génération le coût des neuf précédentes.
 *
 * @param {Uint8Array} octets
 * @param {number} [depuis] somme rendue par un appel précédent, ou 0
 */
export function crc32(octets, depuis = 0) {
  let valeur = (depuis ^ 0xffffffff) >>> 0;
  for (let index = 0; index < octets.byteLength; index += 1) {
    valeur = (TABLE_CRC[(valeur ^ octets[index]) & 0xff] ^ (valeur >>> 8)) >>> 0;
  }
  return (valeur ^ 0xffffffff) >>> 0;
}

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

/**
 * Encode une racine dans un secteur complet.
 *
 * @param {{ sequence: number, generation: number, tailleVolume: number, enregistrements: number,
 *           longueurCharge: number, sommeCharge: number }} racine
 * @returns {Uint8Array} exactement `RACINE_OCTETS` octets
 */
export function encoderRacine({
  sequence,
  generation,
  tailleVolume,
  enregistrements,
  longueurCharge,
  sommeCharge,
}) {
  const octets = new Uint8Array(RACINE_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MAGIC, 0);
  vue.setUint32(8, GENERATION_FORMAT, true);
  vue.setUint32(12, SECTOR_SIZE, true);
  ecrireEntier64(vue, 16, sequence);
  ecrireEntier64(vue, 24, generation);
  ecrireEntier64(vue, 32, tailleVolume);
  vue.setUint32(40, enregistrements, true);
  ecrireEntier64(vue, 44, longueurCharge);
  vue.setUint32(52, sommeCharge >>> 0, true);
  vue.setUint32(56, crc32(octets.subarray(0, 56)), true);
  return octets;
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
 * Relit une racine. Tout doute est un refus : une racine « probablement bonne » n'existe pas.
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
  if (crc32(octets.subarray(0, 56)) !== vue.getUint32(56, true)) {
    return refus("Somme de contrôle de l'en-tête incohérente : racine déchirée ou abîmée.");
  }
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
      enregistrements: vue.getUint32(40, true),
      longueurCharge: lireEntier64(vue, 44),
      sommeCharge: vue.getUint32(52, true),
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
