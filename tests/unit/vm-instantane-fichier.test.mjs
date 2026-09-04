import assert from "node:assert/strict";
import test from "node:test";

import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { INSTANTANE_FORMAT, exigerLiaison } from "../../src/vm/instantane/identite-instantane.mjs";
import {
  INSTANTANE_ERROR_CODES,
  isInstantaneError,
} from "../../src/vm/instantane/instantane-errors.mjs";
import {
  EN_TETE_OCTETS,
  MARQUEUR_COMPLET,
  MARQUEUR_INSTANTANE,
  MARQUE_OCTETS,
  decoderEnTete,
  encoderEnTete,
  marqueCompleteEcrite,
  offsetDeLaMarque,
  offsetDuCorps,
  tailleDeFichier,
} from "../../src/vm/instantane/fichier-instantane.mjs";

// DISPOSITION du fichier `<volume>.instantane` (#65, ADR 0024, décision 2).
//
// Ce module ne chiffre rien : il dit OÙ les octets vivent. Ce que cette épreuve tient :
//
//  - la table d'offsets de l'ADR est celle du code, et un déplacement de champ la fait rougir ;
//  - un fichier qui ne se reconnaît pas est REFUSÉ, jamais réinterprété ;
//  - la marque de complétude est à la FIN, et un fichier sans elle est INCOMPLET — pas malformé,
//    parce que les deux ne se lisent pas de la même façon dans un compte rendu.

const REGION = Uint8Array.from({ length: 32 }, (_, index) => (index * 3 + 1) % 256);
const IMAGE = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 7) % 256);
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
const ETIQUETTE = Uint8Array.from({ length: 16 }, (_, index) => 0xb0 + index);
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

function liaison(remplacements = {}) {
  return exigerLiaison({
    volume: IDENTIFIANT,
    formatInstantane: INSTANTANE_FORMAT,
    formatVolume: 3,
    sequence: 42,
    generation: 17,
    empreinteRegion: REGION,
    empreinteImage: IMAGE,
    longueurEtat: 4096,
    ...remplacements,
  });
}

function enTete(remplacements = {}) {
  return encoderEnTete({ liaison: liaison(remplacements), nonce: NONCE, etiquette: ETIQUETTE });
}

test("l'en-tête occupe exactement la largeur que l'ADR 0024 publie", () => {
  assert.equal(EN_TETE_OCTETS, 152);
  assert.equal(MARQUE_OCTETS, 8);
  assert.equal(enTete().byteLength, EN_TETE_OCTETS);
  assert.equal(offsetDuCorps(), 152);
  assert.equal(offsetDeLaMarque(4096), 152 + 4096);
  assert.equal(tailleDeFichier(4096), 152 + 4096 + 8);
});

test("chaque champ est à l'offset que l'ADR publie", () => {
  const octets = enTete();
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  assert.equal(octetsEnHex(octets.subarray(0, 8)), octetsEnHex(MARQUEUR_INSTANTANE));
  assert.equal(vue.getUint32(8, true), INSTANTANE_FORMAT);
  assert.equal(vue.getUint32(12, true), 3);
  assert.equal(octetsEnHex(octets.subarray(16, 32)), IDENTIFIANT);
  assert.equal(Number(vue.getBigUint64(32, true)), 42);
  assert.equal(Number(vue.getBigUint64(40, true)), 17);
  assert.equal(Number(vue.getBigUint64(48, true)), 4096);
  assert.equal(octetsEnHex(octets.subarray(56, 88)), octetsEnHex(REGION));
  assert.equal(octetsEnHex(octets.subarray(88, 120)), octetsEnHex(IMAGE));
  assert.equal(octetsEnHex(octets.subarray(120, 132)), octetsEnHex(NONCE));
  assert.equal(octetsEnHex(octets.subarray(132, 148)), octetsEnHex(ETIQUETTE));
  assert.equal(octetsEnHex(octets.subarray(148, 152)), "00000000", "la réserve est à zéro");
});

test("l'en-tête se relit tel qu'il a été écrit", () => {
  const lu = decoderEnTete(enTete());
  assert.equal(lu.valide, true, lu.raison ?? "");
  assert.equal(lu.liaison.volume, IDENTIFIANT);
  assert.equal(lu.liaison.formatVolume, 3);
  assert.equal(lu.liaison.sequence, 42);
  assert.equal(lu.liaison.generation, 17);
  assert.equal(lu.liaison.longueurEtat, 4096);
  assert.equal(octetsEnHex(lu.liaison.empreinteRegion), octetsEnHex(REGION));
  assert.equal(octetsEnHex(lu.liaison.empreinteImage), octetsEnHex(IMAGE));
  assert.equal(octetsEnHex(lu.nonce), octetsEnHex(NONCE));
  assert.equal(octetsEnHex(lu.etiquette), octetsEnHex(ETIQUETTE));
});

test("un fichier sans marqueur n'est pas un instantané, et il est REFUSÉ", () => {
  const octets = enTete();
  octets[0] ^= 0xff;
  const lu = decoderEnTete(octets);
  assert.equal(lu.valide, false);
  assert.match(lu.raison, /marqueur/i);
});

test("une version d'instantané inconnue est REFUSÉE, jamais réinterprétée", () => {
  const octets = enTete();
  new DataView(octets.buffer, octets.byteOffset).setUint32(8, INSTANTANE_FORMAT + 1, true);
  const lu = decoderEnTete(octets);
  assert.equal(lu.valide, false);
  assert.match(lu.raison, /version/i);
});

test("un en-tête tronqué est refusé plutôt que complété de zéros", () => {
  const lu = decoderEnTete(enTete().subarray(0, EN_TETE_OCTETS - 1));
  assert.equal(lu.valide, false);
  assert.match(lu.raison, /octets/i);
});

test("la marque de complétude n'est reconnue qu'au motif exact", () => {
  assert.equal(marqueCompleteEcrite(MARQUEUR_COMPLET), true);
  assert.equal(marqueCompleteEcrite(new Uint8Array(MARQUE_OCTETS)), false);
  assert.equal(marqueCompleteEcrite(new Uint8Array(MARQUE_OCTETS).fill(0xff)), false);
  assert.equal(marqueCompleteEcrite(MARQUEUR_COMPLET.subarray(0, 7)), false);
  assert.equal(marqueCompleteEcrite(null), false);
  const presque = Uint8Array.from(MARQUEUR_COMPLET);
  presque[7] ^= 1;
  assert.equal(marqueCompleteEcrite(presque), false, "une marque approchante n'est pas une marque");
});

test("les deux marqueurs sont distincts : un début de fichier n'est pas une fin", () => {
  assert.notEqual(octetsEnHex(MARQUEUR_INSTANTANE), octetsEnHex(MARQUEUR_COMPLET));
});

test("une liaison hors bornes ne s'encode pas en silence", () => {
  assert.throws(
    () => enTete({ sequence: Number.MAX_SAFE_INTEGER }),
    (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.malforme),
  );
});
