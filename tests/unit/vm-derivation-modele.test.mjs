/**
 * Le MODÈLE de la dérivation : encodage de l'info HKDF, paramètres publics, KEK (#22, ADR 0021).
 *
 * Ce fichier est la première moitié de la preuve unitaire. Il ne dérive aucune clé d'un geste
 * utilisateur — c'est l'objet des deux fichiers voisins — et n'éprouve que ce qui est PUR :
 *
 *  1. les octets que HKDF reçoit en `info` et en `salt`, confrontés à un MODÈLE DE RÉFÉRENCE écrit
 *    à part et à des VECTEURS FIGÉS que l'outil `tools/figer-vecteurs-derivation.mjs` pose
 *    lui-même, sans appeler l'encodeur du produit ;
 *  2. l'encodage canonique des paramètres publics de chaque dérivateur — injectif, borné à 512
 *    octets par l'ADR 0020, relu par un décodeur qui refuse plutôt que de compléter ;
 *  3. la KEK rendue : `CryptoKey` AES-GCM de 256 bits, **non extractible**, et d'accord avec le
 *    modèle — ce dernier point ne pouvant PAS se prouver en comparant des octets, puisque la clé de
 *    production n'en rend aucun. Il se prouve en scellant sous l'une et en ouvrant sous l'autre.
 *
 * Chaque refus vient avec son TÉMOIN POSITIF : sans lui, une épreuve de refus reste vraie quand
 * l'encodeur refuse tout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import {
  DERIVATION_VERSION,
  KEK_OCTETS,
  MATERIAU_OCTETS,
  deriverKek,
  encoderInfoDerivation,
} from "../../src/vm/derivation/derivateur.mjs";
import {
  decoderParametresPublics,
  encoderParametresPublics,
} from "../../src/vm/derivation/parametres-publics.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { infoDeReference, okmDeReference } from "./modele-derivation.mjs";

const VECTEURS = JSON.parse(
  await readFile(new URL("../vectors/derivation-v1.json", import.meta.url), "utf8"),
);

/** Identifiant de volume de référence : seize octets, posés plutôt qu'écrits en littéral. */
const VOLUME = octetsEnHex(Uint8Array.from({ length: 16 }, (_, index) => (0x30 + index) % 256));
const EMPLACEMENT = octetsEnHex(Uint8Array.from({ length: 8 }, (_, index) => (0x70 + index) % 256));

test("l'info HKDF est celle du modèle de référence, pour chaque cas figé", () => {
  assert.ok(
    VECTEURS.info.length >= 3,
    "les vecteurs d'info sont trop maigres pour prouver quoi que ce soit",
  );
  for (const cas of VECTEURS.info) {
    const produit = encoderInfoDerivation(cas.entree);
    assert.equal(octetsEnHex(produit), cas.infoHex, `cas « ${cas.nom} » : octets du produit`);
    assert.equal(
      octetsEnHex(infoDeReference(cas.entree)),
      cas.infoHex,
      `cas « ${cas.nom} » : octets du modèle`,
    );
  }
});

test("l'info HKDF est INJECTIVE : deux identités distinctes ne rendent jamais les mêmes octets", () => {
  const vus = new Map();
  const identites = [
    { identifiantVolume: VOLUME, identifiantEmplacement: EMPLACEMENT, version: DERIVATION_VERSION },
    {
      identifiantVolume: VOLUME,
      identifiantEmplacement: octetsEnHex(new Uint8Array(8).fill(0x71)),
      version: DERIVATION_VERSION,
    },
    {
      identifiantVolume: octetsEnHex(new Uint8Array(16).fill(0x31)),
      identifiantEmplacement: EMPLACEMENT,
      version: DERIVATION_VERSION,
    },
    { identifiantVolume: VOLUME, identifiantEmplacement: EMPLACEMENT, version: 2 },
  ];
  for (const identite of identites) {
    const hex = octetsEnHex(encoderInfoDerivation(identite));
    assert.equal(vus.has(hex), false, `collision d'info : ${JSON.stringify(identite)}`);
    vus.set(hex, identite);
  }
});

test("une identité malformée est refusée, et une identité juste passe (témoin)", () => {
  const juste = {
    identifiantVolume: VOLUME,
    identifiantEmplacement: EMPLACEMENT,
    version: DERIVATION_VERSION,
  };
  assert.ok(encoderInfoDerivation(juste) instanceof Uint8Array);
  for (const [nom, mutation] of [
    ["volume trop court", { identifiantVolume: VOLUME.slice(0, 30) }],
    ["volume en majuscules", { identifiantVolume: VOLUME.toUpperCase() }],
    ["emplacement absent", { identifiantEmplacement: undefined }],
    ["version négative", { version: -1 }],
  ]) {
    assert.throws(
      () => encoderInfoDerivation({ ...juste, ...mutation }),
      (erreur) => erreur.code === "VAULT_ENVELOPPE_MALFORME",
      `« ${nom} » aurait dû être refusé`,
    );
  }
});

test("HKDF-SHA-256 rend l'OKM des vecteurs figés", async () => {
  for (const cas of VECTEURS.hkdf) {
    const okm = await okmDeReference({
      materiau: hexEnOctets(cas.materiauHex),
      sel: hexEnOctets(cas.selHex),
      info: hexEnOctets(cas.infoHex),
    });
    assert.equal(octetsEnHex(okm), cas.okmHex, `cas « ${cas.nom} »`);
  }
});

test("la KEK rendue est une CryptoKey AES-GCM de 256 bits, NON EXTRACTIBLE", async () => {
  const kek = await deriverKek({
    materiau: new Uint8Array(MATERIAU_OCTETS).fill(0x5a),
    sel: new Uint8Array(16).fill(0x0f),
    info: encoderInfoDerivation({
      identifiantVolume: VOLUME,
      identifiantEmplacement: EMPLACEMENT,
      version: DERIVATION_VERSION,
    }),
  });
  assert.equal(kek instanceof CryptoKey, true);
  assert.equal(
    kek.extractable,
    false,
    "la KEK est extractible : ses octets peuvent quitter WebCrypto",
  );
  assert.equal(kek.algorithm.name, "AES-GCM");
  assert.equal(kek.algorithm.length, KEK_OCTETS * 8);
  assert.deepEqual([...kek.usages].sort(), ["decrypt", "encrypt"]);
  await assert.rejects(() => crypto.subtle.exportKey("raw", kek));
});

test("la KEK de production est CELLE du modèle : scellée sous l'une, ouverte sous l'autre", async () => {
  const materiau = new Uint8Array(MATERIAU_OCTETS).fill(0x21);
  const sel = new Uint8Array(16).fill(0x22);
  const info = encoderInfoDerivation({
    identifiantVolume: VOLUME,
    identifiantEmplacement: EMPLACEMENT,
    version: DERIVATION_VERSION,
  });

  // Chacun reçoit sa COPIE, parce que `deriverKek` met le matériau à zéro dès que la clé existe —
  // c'est la fenêtre refermée que l'ADR 0021 décrit, et l'assertion ci-dessous la mesure.
  const pourLaProduction = materiau.slice();
  const production = await deriverKek({ materiau: pourLaProduction, sel, info });
  assert.deepEqual(
    pourLaProduction,
    new Uint8Array(MATERIAU_OCTETS),
    "le matériau n'a pas été mis à zéro après la dérivation",
  );
  const modele = await crypto.subtle.importKey(
    "raw",
    await okmDeReference({ materiau: materiau.slice(), sel, info }),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const nonce = new Uint8Array(12).fill(0x33);
  const clair = new TextEncoder().encode("la KEK du produit et celle du modèle sont la même");
  const scelle = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, production, clair);
  const ouvert = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, modele, scelle);
  assert.deepEqual(new Uint8Array(ouvert), clair);
});

test("un matériau qui ne fait pas la bonne largeur est refusé, un juste passe (témoin)", async () => {
  const juste = {
    materiau: new Uint8Array(MATERIAU_OCTETS).fill(0x01),
    sel: new Uint8Array(16),
    info: new Uint8Array(4),
  };
  assert.ok(await deriverKek(juste));
  for (const largeur of [0, 16, 31, 33, 64]) {
    await assert.rejects(
      () => deriverKek({ ...juste, materiau: new Uint8Array(largeur) }),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
      `un matériau de ${largeur} octets aurait dû être refusé`,
    );
  }
});

test("les paramètres publics de chaque type sont ceux des vecteurs figés, et se relisent", () => {
  assert.ok(VECTEURS.parametres.length >= 2, "il faut au moins un cas par type de dérivateur");
  for (const cas of VECTEURS.parametres) {
    const octets = encoderParametresPublics(TYPES_KEK[cas.type], cas.valeurs);
    assert.equal(octetsEnHex(octets), cas.octetsHex, `cas « ${cas.nom} » : encodage`);
    // Le décodeur rend EXACTEMENT ce que l'encodeur a reçu — sel et identifiants en hexadécimal
    // minuscule, coûts en entiers. Un aller-retour qui perdrait un champ ne serait pas un
    // encodage injectif, et l'authentification de ces octets par l'ADR 0020 ne vaudrait rien.
    assert.deepEqual(decoderParametresPublics(TYPES_KEK[cas.type], octets), cas.valeurs, cas.nom);
  }
});

test("le décodeur des paramètres publics REFUSE plutôt que de compléter", () => {
  const octets = encoderParametresPublics(TYPES_KEK.phrase, VECTEURS.parametres[0].valeurs);
  // Témoin : tels quels, ils se relisent.
  assert.ok(decoderParametresPublics(TYPES_KEK.phrase, octets));

  const tronques = octets.slice(0, octets.byteLength - 1);
  const rallonges = new Uint8Array(octets.byteLength + 1);
  rallonges.set(octets);
  for (const [nom, candidat] of [
    ["tronqués", tronques],
    ["suivis d'un octet de trop", rallonges],
    ["vides", new Uint8Array(0)],
  ]) {
    assert.throws(
      () => decoderParametresPublics(TYPES_KEK.phrase, candidat),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
      `des paramètres ${nom} auraient dû être refusés`,
    );
  }
});

test("un type de clé de déverrouillage inconnu est refusé par un code typé, jamais deviné", () => {
  for (const typeInconnu of [0, 4, 7, 255]) {
    assert.throws(
      () => encoderParametresPublics(typeInconnu, {}),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.typeInconnu),
      `le type ${typeInconnu} aurait dû être refusé`,
    );
    assert.throws(
      () => decoderParametresPublics(typeInconnu, new Uint8Array(4)),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.typeInconnu),
    );
  }
});

test("des paramètres publics au-delà du plafond de l'ADR 0020 sont refusés", () => {
  assert.throws(
    () =>
      encoderParametresPublics(TYPES_KEK["webauthn-prf"], {
        rpId: "localhost",
        identifiantCredential: octetsEnHex(new Uint8Array(600).fill(0x44)),
        sel: octetsEnHex(new Uint8Array(32).fill(0x45)),
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
  );
});
