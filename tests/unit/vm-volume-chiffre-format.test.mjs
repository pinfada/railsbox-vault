// Disposition du format de volume v3 (#18, ADR 0016).
//
// Ce fichier éprouve les OCTETS et les OFFSETS, rien d'autre : où vit l'en-tête, où vit le sceau
// d'un secteur logique, combien la région d'authentification coûte. Le scellement lui-même est
// éprouvé par `vm-volume-chiffre.test.mjs`, et sa cryptographie par les vecteurs de l'ADR 0015.
//
// Les tailles ne sont pas recalculées par l'épreuve : elles sont ÉCRITES, telles que l'ADR 0016 les
// publie. Une épreuve qui referait le calcul du module validerait le calcul contre lui-même.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  MARQUEUR_V3,
  SCEAU_OCTETS,
  decoderEnTeteV3,
  decoderSceau,
  dispositionV3,
  encoderEnTeteV3,
  encoderSceau,
  offsetDeCharge,
  offsetDeSceau,
} from "../../src/vm/volume-chiffre-format.mjs";

const MIO = 1024 * 1024;

/** Seize octets d'identifiant, distincts et non nuls, pour qu'un décalage se voie. */
const IDENTIFIANT = Uint8Array.from({ length: 16 }, (_, index) => index * 17 + 3);

test("un sceau fait 34 octets : nonce 12, étiquette 16, génération 6", () => {
  assert.equal(SCEAU_OCTETS, 34);
  assert.equal(EN_TETE_OCTETS, SECTOR_SIZE);
  assert.equal(FORMAT_VOLUME_V3, 3);
});

test("la disposition d'un volume de 512 Mio tombe juste sur 69 632 secteurs de région", () => {
  const disposition = dispositionV3(512 * MIO);
  assert.equal(disposition.tailleLogique, 536870912);
  assert.equal(disposition.secteurs, 1048576);
  assert.equal(disposition.regionOffset, 512);
  assert.equal(disposition.regionOctets, 35651584, "1 048 576 × 34 octets");
  assert.equal(disposition.regionOctets / SECTOR_SIZE, 69632, "la région tombe juste");
  assert.equal(disposition.chargeOffset, 512 + 35651584);
  assert.equal(disposition.tailleSupport, 512 + 35651584 + 536870912);
});

test("une région qui ne tombe pas juste est alignée VERS LE HAUT, jamais tronquée", () => {
  // 10 secteurs → 340 octets de sceaux, qui n'occupent pas un secteur entier. Tronquer priverait
  // les derniers secteurs de leur sceau, c'est-à-dire les rendrait illisibles.
  const disposition = dispositionV3(10 * SECTOR_SIZE);
  assert.equal(disposition.secteurs, 10);
  assert.equal(disposition.regionOctets, SECTOR_SIZE, "340 octets alignés sur un secteur");
  assert.equal(disposition.chargeOffset, 512 + 512);
  assert.equal(disposition.tailleSupport, 512 + 512 + 10 * SECTOR_SIZE);
});

test("une taille logique qui n'est pas un multiple de secteur est refusée, jamais arrondie", () => {
  assert.throws(() => dispositionV3(SECTOR_SIZE + 1), RangeError);
  assert.throws(() => dispositionV3(0), RangeError);
});

test("chaque secteur logique a un offset de charge et un offset de sceau qui ne se croisent pas", () => {
  const disposition = dispositionV3(512 * MIO);
  assert.equal(offsetDeCharge(disposition, 0), disposition.chargeOffset);
  assert.equal(offsetDeSceau(disposition, 0), disposition.regionOffset);
  assert.equal(offsetDeCharge(disposition, SECTOR_SIZE), disposition.chargeOffset + SECTOR_SIZE);
  assert.equal(offsetDeSceau(disposition, SECTOR_SIZE), disposition.regionOffset + SCEAU_OCTETS);

  const dernier = disposition.tailleLogique - SECTOR_SIZE;
  assert.equal(
    offsetDeSceau(disposition, dernier) + SCEAU_OCTETS,
    disposition.regionOffset + disposition.secteurs * SCEAU_OCTETS,
  );
  assert.ok(
    offsetDeSceau(disposition, dernier) + SCEAU_OCTETS <= disposition.chargeOffset,
    "le dernier sceau reste dans la région : sans quoi il écraserait la charge",
  );
});

test("une adresse non alignée ou hors bornes est refusée plutôt que ramenée dans les clous", () => {
  const disposition = dispositionV3(10 * SECTOR_SIZE);
  assert.throws(() => offsetDeCharge(disposition, 1), RangeError);
  assert.throws(() => offsetDeSceau(disposition, 1), RangeError);
  assert.throws(() => offsetDeCharge(disposition, 10 * SECTOR_SIZE), RangeError);
  assert.throws(() => offsetDeSceau(disposition, -SECTOR_SIZE), RangeError);
});

test("un sceau fait l'aller-retour sans perdre un octet", () => {
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
  const etiquette = Uint8Array.from({ length: 16 }, (_, index) => 200 - index);
  const scelle = encoderSceau({ nonce, etiquette, generation: 0x0102030405 });

  assert.equal(scelle.byteLength, SCEAU_OCTETS);
  const relu = decoderSceau(scelle);
  assert.deepEqual(relu.nonce, nonce);
  assert.deepEqual(relu.etiquette, etiquette);
  assert.equal(relu.generation, 0x0102030405);
});

test("une génération au-delà de six octets est refusée : elle ne tiendrait pas dans le sceau", () => {
  const nonce = new Uint8Array(12);
  const etiquette = new Uint8Array(16);
  assert.throws(() => encoderSceau({ nonce, etiquette, generation: 2 ** 48 }), RangeError);
});

test("un sceau ENTIÈREMENT À ZÉRO se décode, et c'est délibéré", () => {
  // Il n'y a pas de « secteur jamais écrit » en v3 (ADR 0015). Un sceau nul n'est donc pas un état
  // reconnu par le format : il se décode comme n'importe quel autre, et c'est l'ÉTIQUETTE qui le
  // refuse. Le distinguer ici rendrait un secteur zéroté « vierge » plutôt que « refusé » — c'est
  // exactement l'attaque que l'ADR 0015 nomme.
  const relu = decoderSceau(new Uint8Array(SCEAU_OCTETS));
  assert.equal(relu.generation, 0);
  assert.equal(relu.nonce.byteLength, 12);
  assert.equal(relu.etiquette.byteLength, 16);
});

test("l'en-tête v3 fait un secteur, porte son marqueur et rend ce qu'il a reçu", () => {
  const octets = encoderEnTeteV3({ tailleLogique: 512 * MIO, identifiantVolume: IDENTIFIANT });
  assert.equal(octets.byteLength, SECTOR_SIZE);
  assert.deepEqual(octets.subarray(0, 8), MARQUEUR_V3);

  const lu = decoderEnTeteV3(octets);
  assert.equal(lu.valide, true, lu.raison ?? "");
  assert.equal(lu.enTete.formatVersion, FORMAT_VOLUME_V3);
  assert.equal(lu.enTete.tailleSecteur, SECTOR_SIZE);
  assert.equal(lu.enTete.tailleLogique, 512 * MIO);
  assert.deepEqual(lu.enTete.identifiantVolume, IDENTIFIANT);
  assert.equal(lu.enTete.regionOffset, 512);
  assert.equal(lu.enTete.regionOctets, 35651584);
  assert.equal(lu.enTete.chargeOffset, 512 + 35651584);
});

test("la réserve de l'en-tête v3 est à zéro : elle est réservée, pas remplie de reliquats", () => {
  const octets = encoderEnTeteV3({ tailleLogique: 512 * MIO, identifiantVolume: IDENTIFIANT });
  assert.deepEqual(octets.subarray(64), new Uint8Array(SECTOR_SIZE - 64));
});

test("un en-tête sans marqueur, d'une autre version ou d'une autre géométrie est REFUSÉ", () => {
  const bon = encoderEnTeteV3({ tailleLogique: 512 * MIO, identifiantVolume: IDENTIFIANT });

  const sansMarqueur = Uint8Array.from(bon);
  sansMarqueur[0] ^= 0xff;
  assert.equal(decoderEnTeteV3(sansMarqueur).valide, false);
  assert.match(decoderEnTeteV3(sansMarqueur).raison, /marqueur/i);

  const versionFuture = Uint8Array.from(bon);
  new DataView(versionFuture.buffer).setUint32(8, FORMAT_VOLUME_V3 + 1, true);
  assert.equal(decoderEnTeteV3(versionFuture).valide, false);
  assert.match(decoderEnTeteV3(versionFuture).raison, /format/i);

  const autreSecteur = Uint8Array.from(bon);
  new DataView(autreSecteur.buffer).setUint32(12, 4096, true);
  assert.equal(decoderEnTeteV3(autreSecteur).valide, false);
  assert.match(decoderEnTeteV3(autreSecteur).raison, /secteur/i);
});

test("un en-tête dont la disposition ne se déduit pas de sa taille logique est refusé", () => {
  // L'en-tête LOCALISE ; il n'a pas le droit de mentir sur l'endroit où la charge commence. Les
  // trois offsets qu'il porte doivent être exactement ceux que la taille logique impose.
  const bon = encoderEnTeteV3({ tailleLogique: 512 * MIO, identifiantVolume: IDENTIFIANT });
  const deplace = Uint8Array.from(bon);
  const vue = new DataView(deplace.buffer);
  vue.setUint32(40, 512, true);
  vue.setUint32(44, 0, true);
  const lu = decoderEnTeteV3(deplace);
  assert.equal(lu.valide, false);
  assert.match(lu.raison, /charge|disposition|offset/i);
});
