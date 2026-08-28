// REJEU d'un journal de génération au format 1, avant de migrer le volume qui le porte (#101).
//
// ## Pourquoi ce module existe
//
// Le format du journal de génération est passé de **1 à 2** avec le format de volume v3 (#18) : la
// racine a grandi de 60 à 136 octets et son CRC-32 a été remplacé par une étiquette
// authentifiée. Le lecteur de la version 1 a disparu avec ce changement — et c'est là qu'un défaut
// s'est glissé, que la revue de #110 a nommé.
//
// Un volume v2 qui a réellement servi porte un voisin `<volume>.gen` au format 1. Deux choses lui
// arrivaient, toutes deux mauvaises :
//
//  - **une écriture ACQUITTÉE encore dans ce journal n'était jamais rejouée.** Une génération
//    validée vit dans le journal jusqu'à ce qu'une ouverture la reporte dans le volume ; migrer
//    sans la reporter la perd, silencieusement, alors que le guest a reçu son acquittement ;
//  - **le journal survivait à la migration**, et le volume tout juste migré NE S'OUVRAIT PLUS :
//    `decoderRacine` y voyait un format 1 là où il attend un format 2 et rendait
//    `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` — « restaurer une sauvegarde » — alors que les données
//    étaient intactes.
//
// L'en-tête de `migration-v3.mjs` affirmait pourtant que « le journal du volume source est écarté
// par l'orchestration ». Aucun code ne le faisait. C'est le genre de phrase que ce dépôt s'interdit,
// et le remède n'est pas de la retirer : c'est de la rendre vraie.
//
// ## Ce que ce module fait, et ne fait pas
//
// Il REJOUE : il relit la racine qui fait autorité, vérifie la charge, et rend les écritures à
// reporter dans le volume. Il n'écrit rien lui-même et ne connaît ni OPFS ni chiffrement — le
// volume est encore en v2 à ce moment-là, donc en clair, et reporter une écriture y est une simple
// recopie d'octets.
//
// Il ne SCELLE pas, ne convertit pas, et n'écarte pas le journal : ces gestes appartiennent à
// l'orchestration, qui seule sait dans quel ordre les poser (ADR 0011).
//
// Le format lu ici est FIGÉ : c'est celui d'un volume déjà écrit sur le disque de quelqu'un, et il
// ne changera plus. Les constantes sont donc écrites en clair plutôt qu'importées d'un module qui,
// lui, suit le format courant — les faire suivre le format courant est exactement ce qui a rendu ce
// journal illisible.

import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";

/** Marqueur d'une racine au format 1 : « VLTGEN01 ». */
const MARQUEUR_V1 = Uint8Array.from([0x56, 0x4c, 0x54, 0x47, 0x45, 0x4e, 0x30, 0x31]);

/** Version de format de journal que ce module sait lire, et la seule. */
export const FORMAT_JOURNAL_V1 = 1;

/** En-tête d'une racine v1. Le reste du secteur est réservé. */
const RACINE_ENTETE_V1 = 60;

/** Deux emplacements de racine, séparés par une PAGE HÔTE — inchangé entre les deux formats. */
const RACINES = 2;
const PAGE_HOTE_OCTETS = 4096;
const ZONE_ENREGISTREMENTS = RACINES * PAGE_HOTE_OCTETS;

/** En-tête d'un enregistrement : offset sur 64 bits, longueur sur 32, réserve sur 32. */
const ENTETE_ENREGISTREMENT = 16;

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

/** CRC-32 du format 1, poursuivant éventuellement une somme déjà commencée. */
function crc32(octets, depuis = 0) {
  let valeur = (depuis ^ 0xffffffff) >>> 0;
  for (let index = 0; index < octets.byteLength; index += 1) {
    valeur = (TABLE_CRC[(valeur ^ octets[index]) & 0xff] ^ (valeur >>> 8)) >>> 0;
  }
  return (valeur ^ 0xffffffff) >>> 0;
}

function lireEntier64(vue, position) {
  return vue.getUint32(position, true) + vue.getUint32(position + 4, true) * 2 ** 32;
}

function estVierge(octets) {
  for (let index = 0; index < RACINE_ENTETE_V1; index += 1) {
    if (octets[index] !== 0) return false;
  }
  return true;
}

/**
 * Relit une racine v1. Comme dans le format qu'elle décrit, tout doute est un refus : une racine
 * « probablement bonne » n'existe pas.
 */
function decoderRacineV1(octets, tailleVolume) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < RACINE_ENTETE_V1) return null;
  if (estVierge(octets)) return null;
  if (!MARQUEUR_V1.every((attendu, position) => octets[position] === attendu)) return null;

  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  if (crc32(octets.subarray(0, 56)) !== vue.getUint32(56, true)) return null;
  if (vue.getUint32(8, true) !== FORMAT_JOURNAL_V1) return null;
  if (lireEntier64(vue, 32) !== tailleVolume) return null;

  return Object.freeze({
    sequence: lireEntier64(vue, 16),
    generation: lireEntier64(vue, 24),
    enregistrements: vue.getUint32(40, true),
    longueurCharge: lireEntier64(vue, 44),
    sommeCharge: vue.getUint32(52, true),
  });
}

function refus(raison, contexte) {
  return new MigrationError(
    MIGRATION_ERROR_CODES.journalMalformed,
    `Migration refusée : le journal de génération du volume source est présent mais illisible — ${raison}. Il peut porter une écriture ACQUITTÉE, et migrer sans elle la perdrait sans le dire. Le volume n'est pas touché.`,
    contexte,
  );
}

/**
 * Relit un journal de génération v1 et rend les écritures qu'il reste à REPORTER dans le volume.
 *
 * @param {{ octets: Uint8Array | null, tailleVolume: number }} entree
 *   `octets` est le fichier `<volume>.gen` entier, ou `null` s'il n'y en a pas.
 * @returns {{ generation: number, ecritures: { offset: number, octets: Uint8Array }[] }}
 *   `ecritures` est vide quand il n'y a rien à reporter — journal absent, jamais validé, ou vide.
 * @throws {MigrationError} `VAULT_MIGRATION_JOURNAL_MALFORMED` si le journal existe et se contredit
 */
export function ecrituresARejouerV1({ octets, tailleVolume }) {
  const vide = Object.freeze({ generation: 0, ecritures: Object.freeze([]) });
  if (octets === null || octets === undefined || octets.byteLength < ZONE_ENREGISTREMENTS) {
    return vide;
  }

  // La racine qui fait AUTORITÉ est celle de plus grande séquence parmi les lisibles. Une racine
  // illisible n'est pas ignorée en silence : si aucune ne se lit alors que le fichier n'est pas
  // vierge, on refuse — on ne sait pas ce qui a été validé.
  let retenue = null;
  let vierges = 0;
  for (let rang = 0; rang < RACINES; rang += 1) {
    const debut = rang * PAGE_HOTE_OCTETS;
    const secteur = octets.subarray(debut, debut + RACINE_ENTETE_V1);
    if (estVierge(secteur)) {
      vierges += 1;
      continue;
    }
    const lue = decoderRacineV1(secteur, tailleVolume);
    if (lue === null) {
      throw refus("une de ses racines ne se relit pas", { rang, tailleVolume });
    }
    if (retenue === null || lue.sequence > retenue.sequence) retenue = lue;
  }
  if (retenue === null) {
    // Les deux emplacements sont vierges : ce journal n'a jamais rien validé. C'est l'état d'un
    // volume dont la dernière session s'est terminée proprement, et il n'y a rien à reporter.
    if (vierges === RACINES) return vide;
    throw refus("aucune de ses racines ne fait autorité", { vierges });
  }
  if (retenue.enregistrements === 0 || retenue.longueurCharge === 0) return vide;

  return Object.freeze({
    generation: retenue.generation,
    ecritures: parcourirCharge(octets, retenue, tailleVolume),
  });
}

/**
 * Parcourt la charge validée et rend ses écritures, dans l'ordre de dépôt.
 *
 * L'ordre est celui du contrat : deux écritures qui se recouvrent doivent être rejouées dans l'ordre
 * où le guest les a émises, sans quoi la plus ancienne gagnerait.
 */
function parcourirCharge(octets, racine, tailleVolume) {
  const debut = ZONE_ENREGISTREMENTS;
  const fin = debut + racine.longueurCharge;
  if (fin > octets.byteLength) {
    throw refus("sa charge validée dépasse le fichier", {
      longueurCharge: racine.longueurCharge,
      fichier: octets.byteLength,
    });
  }

  const ecritures = [];
  let somme = 0;
  let position = debut;
  for (let rang = 0; rang < racine.enregistrements; rang += 1) {
    if (position + ENTETE_ENREGISTREMENT > fin) {
      throw refus("un de ses enregistrements est tronqué", { rang });
    }
    const entete = octets.subarray(position, position + ENTETE_ENREGISTREMENT);
    const vue = new DataView(entete.buffer, entete.byteOffset, entete.byteLength);
    const offset = lireEntier64(vue, 0);
    const longueur = vue.getUint32(8, true);
    position += ENTETE_ENREGISTREMENT;
    if (longueur === 0 || offset + longueur > tailleVolume || position + longueur > fin) {
      throw refus("un de ses enregistrements sort du volume", { rang, offset, longueur });
    }
    const tranche = octets.subarray(position, position + longueur);
    position += longueur;
    somme = crc32(entete, somme);
    somme = crc32(tranche, somme);
    ecritures.push(Object.freeze({ offset, octets: tranche.slice() }));
  }

  if (somme !== racine.sommeCharge) {
    throw refus("la somme de contrôle de sa charge ne correspond pas", {
      attendue: racine.sommeCharge,
      obtenue: somme,
    });
  }
  return Object.freeze(ecritures);
}
