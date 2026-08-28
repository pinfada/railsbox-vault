// Un journal de génération au FORMAT 1, relu avant migration (#101, revue de #110).
//
// Le format du journal est passé de 1 à 2 avec le volume v3, et son lecteur v1 a disparu avec le
// changement. Un volume v2 qui a réellement servi en porte pourtant un : sa dernière génération
// VALIDÉE y attend d'être reportée dans le volume. Migrer sans la reporter perd une écriture
// acquittée — silencieusement —, et laisser le fichier derrière soi empêche le volume migré de
// s'ouvrir.
//
// Le journal construit ici l'est À LA MAIN, d'après le format figé de la version 1. C'est
// délibéré : ce format ne changera plus — il est déjà sur le disque de quelqu'un —, et le relire
// avec un encodeur qui suit le format COURANT est exactement ce qui a produit le défaut.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { MIGRATION_ERROR_CODES, isMigrationError } from "../../src/vm/migration-errors.mjs";
import { ecrituresARejouerV1 } from "../../src/vm/generation-v1-rejeu.mjs";

const TAILLE_VOLUME = 8 * SECTOR_SIZE;
const PAGE_HOTE = 4096;
const ZONE = 2 * PAGE_HOTE;

const TABLE = (() => {
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

function crc32(octets, depuis = 0) {
  let valeur = (depuis ^ 0xffffffff) >>> 0;
  for (let index = 0; index < octets.byteLength; index += 1) {
    valeur = (TABLE[(valeur ^ octets[index]) & 0xff] ^ (valeur >>> 8)) >>> 0;
  }
  return (valeur ^ 0xffffffff) >>> 0;
}

function ecrire64(vue, position, valeur) {
  vue.setUint32(position, valeur >>> 0, true);
  vue.setUint32(position + 4, Math.floor(valeur / 2 ** 32), true);
}

/**
 * Construit un journal v1 portant `ecritures` sous une racine VALIDÉE.
 *
 * @param {{ offset: number, octets: Uint8Array }[]} ecritures
 * @param {{ rang?: number, sequence?: number, generation?: number, abimerSomme?: boolean }} options
 */
function journalV1(
  ecritures,
  { rang = 0, sequence = 1, generation = 3, abimerSomme = false } = {},
) {
  const morceaux = [];
  let somme = 0;
  for (const ecriture of ecritures) {
    const entete = new Uint8Array(16);
    const vueEntete = new DataView(entete.buffer);
    ecrire64(vueEntete, 0, ecriture.offset);
    vueEntete.setUint32(8, ecriture.octets.byteLength, true);
    somme = crc32(entete, somme);
    somme = crc32(ecriture.octets, somme);
    morceaux.push(entete, ecriture.octets);
  }
  const longueurCharge = morceaux.reduce((total, m) => total + m.byteLength, 0);

  const fichier = new Uint8Array(ZONE + longueurCharge);
  let position = ZONE;
  for (const morceau of morceaux) {
    fichier.set(morceau, position);
    position += morceau.byteLength;
  }

  const racine = new Uint8Array(SECTOR_SIZE);
  const vue = new DataView(racine.buffer);
  racine.set([0x56, 0x4c, 0x54, 0x47, 0x45, 0x4e, 0x30, 0x31], 0); // « VLTGEN01 »
  vue.setUint32(8, 1, true); // format 1
  vue.setUint32(12, SECTOR_SIZE, true);
  ecrire64(vue, 16, sequence);
  ecrire64(vue, 24, generation);
  ecrire64(vue, 32, TAILLE_VOLUME);
  vue.setUint32(40, ecritures.length, true);
  ecrire64(vue, 44, longueurCharge);
  vue.setUint32(52, abimerSomme ? (somme ^ 0xffff) >>> 0 : somme, true);
  vue.setUint32(56, crc32(racine.subarray(0, 56)), true);
  fichier.set(racine, rang * PAGE_HOTE);
  return fichier;
}

const MOTIF = (graine) =>
  Uint8Array.from({ length: SECTOR_SIZE }, (_, i) => (i * 7 + graine) % 256);

test("un journal ABSENT ne donne rien à rejouer, et ce n'est pas une erreur", () => {
  const rendu = ecrituresARejouerV1({ octets: null, tailleVolume: TAILLE_VOLUME });
  assert.deepEqual(rendu.ecritures, []);
});

test("un journal aux DEUX racines vierges n'a jamais rien validé : rien à rejouer", () => {
  // C'est l'état d'un volume dont la dernière session s'est terminée proprement.
  const rendu = ecrituresARejouerV1({
    octets: new Uint8Array(ZONE),
    tailleVolume: TAILLE_VOLUME,
  });
  assert.deepEqual(rendu.ecritures, []);
});

test("une écriture ACQUITTÉE encore dans le journal est rendue, telle qu'elle a été déposée", () => {
  const ecritures = [
    { offset: 0, octets: MOTIF(1) },
    { offset: 3 * SECTOR_SIZE, octets: MOTIF(2) },
  ];
  const rendu = ecrituresARejouerV1({
    octets: journalV1(ecritures),
    tailleVolume: TAILLE_VOLUME,
  });

  assert.equal(rendu.generation, 3);
  assert.equal(rendu.ecritures.length, 2);
  assert.equal(rendu.ecritures[0].offset, 0);
  assert.deepEqual([...rendu.ecritures[0].octets], [...MOTIF(1)]);
  assert.equal(rendu.ecritures[1].offset, 3 * SECTOR_SIZE);
  assert.deepEqual([...rendu.ecritures[1].octets], [...MOTIF(2)]);
});

test("la racine de plus grande SÉQUENCE fait autorité, comme dans le format qu'elle décrit", () => {
  // Les deux emplacements alternent : le plus récent est celui dont la séquence est la plus haute,
  // et non celui qui vient en premier dans le fichier.
  const ancien = journalV1([{ offset: 0, octets: MOTIF(1) }], { rang: 0, sequence: 1 });
  const recent = journalV1([{ offset: SECTOR_SIZE, octets: MOTIF(9) }], {
    rang: 1,
    sequence: 7,
    generation: 12,
  });
  // Les deux racines dans le même fichier, la charge étant celle de la plus récente.
  const fichier = Uint8Array.from(recent);
  fichier.set(ancien.subarray(0, SECTOR_SIZE), 0);

  const rendu = ecrituresARejouerV1({ octets: fichier, tailleVolume: TAILLE_VOLUME });
  assert.equal(rendu.generation, 12);
  assert.equal(rendu.ecritures[0].offset, SECTOR_SIZE);
});

test("une charge dont la SOMME ne correspond pas est refusée, jamais rejouée à moitié", () => {
  assert.throws(
    () =>
      ecrituresARejouerV1({
        octets: journalV1([{ offset: 0, octets: MOTIF(1) }], { abimerSomme: true }),
        tailleVolume: TAILLE_VOLUME,
      }),
    (erreur) => {
      assert.ok(isMigrationError(erreur, MIGRATION_ERROR_CODES.journalMalformed), erreur.message);
      assert.match(erreur.message, /ACQUITT/, "le refus dit ce qu'on risque de perdre");
      return true;
    },
  );
});

test("une racine PRÉSENTE mais illisible est refusée : on ne sait pas ce qui a été validé", () => {
  const fichier = journalV1([{ offset: 0, octets: MOTIF(1) }]);
  fichier[57] ^= 0x01; // le CRC de l'en-tête de racine
  assert.throws(
    () => ecrituresARejouerV1({ octets: fichier, tailleVolume: TAILLE_VOLUME }),
    (erreur) => isMigrationError(erreur, MIGRATION_ERROR_CODES.journalMalformed),
  );
});

test("un enregistrement qui sort du volume est refusé, jamais écrit hors bornes", () => {
  const fichier = journalV1([{ offset: 0, octets: MOTIF(1) }]);
  const vue = new DataView(fichier.buffer);
  ecrire64(vue, ZONE, TAILLE_VOLUME); // un offset qui place l'enregistrement hors du volume
  assert.throws(
    () => ecrituresARejouerV1({ octets: fichier, tailleVolume: TAILLE_VOLUME }),
    (erreur) => isMigrationError(erreur, MIGRATION_ERROR_CODES.journalMalformed),
  );
});

test("une racine écrite pour un AUTRE volume est refusée", () => {
  assert.throws(
    () =>
      ecrituresARejouerV1({
        octets: journalV1([{ offset: 0, octets: MOTIF(1) }]),
        tailleVolume: TAILLE_VOLUME * 2,
      }),
    (erreur) => isMigrationError(erreur, MIGRATION_ERROR_CODES.journalMalformed),
  );
});
