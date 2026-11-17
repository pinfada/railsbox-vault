/**
 * Le DESCRIPTEUR SCELLÉ (#247, D1g ; ADR 0045) : le format persistant rangé au magasin pour démarrer
 * hors connexion. Un adversaire qui écrit dans l'OPFS SANS la clé du coffre ne peut ni le fabriquer
 * ni le modifier ; un fichier non scellé, d'une autre version ou d'un autre coffre est REFUSÉ — jamais
 * accepté, jamais lu « au mieux ».
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { chainePrefixee, concatener } from "../../src/vm/format-chiffre/octets.mjs";
import {
  ETIQUETTE_DU_SCELLEMENT,
  EN_TETE_OCTETS,
  MAGIE_DU_DESCRIPTEUR_SCELLE,
  TAILLE_MAX_DE_LA_CHARGE,
  TAILLE_DU_SCEAU,
  ouvrirLeDescripteurScelle,
  sceller,
} from "../../src/coquille/descripteur-scelle.mjs";
import { deriverCleDeScellementDuDescripteur } from "../../src/vm/derivation/cle-du-descripteur-scelle.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const IDENTIFIANT = "21282f363d444b525960676e757c838a";
const cleDe = (octet) =>
  deriverCleDeScellementDuDescripteur({
    cleMaitresse: new Uint8Array(32).fill(octet),
    identifiantVolume: IDENTIFIANT,
  });
const MANIFESTE_V86 = {
  artifacts: [
    { name: "libv86.mjs", bytes: 356131, sha256: "4".repeat(64) },
    { name: "v86.wasm", bytes: 2096474, sha256: "8".repeat(64) },
  ],
};
const RANGE_LE = Date.UTC(2026, 10, 7, 15, 54, 38);

async function scelle(options = {}) {
  return sceller({
    descripteur: descripteurDEpreuve(),
    manifesteV86: MANIFESTE_V86,
    rangeLe: RANGE_LE,
    cle: await cleDe(1),
    ...options,
  });
}

const refus = (raison) => ({
  code: C.horsLigneDescripteurRefuse,
  contexte: { raison },
});

test("le format : magie « VLTDSC01 », date U64, longueur U32, charge JSON UTF-8, sceau de 32 octets", async () => {
  const octets = await scelle();
  assert.equal(new TextDecoder().decode(octets.subarray(0, 8)), MAGIE_DU_DESCRIPTEUR_SCELLE);
  assert.equal(MAGIE_DU_DESCRIPTEUR_SCELLE, "VLTDSC01");
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  assert.equal(vue.getBigUint64(8), BigInt(RANGE_LE));
  const longueur = vue.getUint32(16);
  assert.equal(EN_TETE_OCTETS, 20);
  assert.equal(TAILLE_DU_SCEAU, 32);
  assert.equal(octets.byteLength, EN_TETE_OCTETS + longueur + TAILLE_DU_SCEAU);
  const charge = JSON.parse(new TextDecoder().decode(octets.subarray(20, 20 + longueur)));
  assert.deepEqual(Object.keys(charge).sort(), ["descripteur", "manifesteV86"]);
  assert.deepEqual(charge.descripteur, descripteurDEpreuve());
});

test("aller-retour : le descripteur, le manifeste v86 et la date reviennent tels quels", async () => {
  const ouvert = await ouvrirLeDescripteurScelle({ octets: await scelle(), cle: await cleDe(1) });
  assert.deepEqual(ouvert.descripteur, descripteurDEpreuve());
  assert.deepEqual(ouvert.manifesteV86, MANIFESTE_V86);
  assert.equal(ouvert.rangeLe, RANGE_LE);
});

test("un octet changé N'IMPORTE OÙ — magie, date, longueur, charge, sceau — est refusé", async () => {
  const cle = await cleDe(1);
  const original = await scelle();
  for (let position = 0; position < original.byteLength; position += 1) {
    const altere = original.slice();
    altere[position] ^= 0x01;
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets: altere, cle }),
      (erreur) => erreur.code === C.horsLigneDescripteurRefuse,
      `octet ${position}`,
    );
  }
});

test("la date est AUTHENTIFIÉE : la changer sans la clé donne le refus du sceau", async () => {
  const altere = (await scelle()).slice();
  new DataView(altere.buffer).setBigUint64(8, BigInt(RANGE_LE + 1));
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: altere, cle: await cleDe(1) }),
    refus("sceau"),
  );
});

test("un descripteur fabriqué sous une AUTRE clé est refusé par le sceau", async () => {
  const fabrique = await scelle({ cle: await cleDe(2) });
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: fabrique, cle: await cleDe(1) }),
    refus("sceau"),
  );
});

test("un descripteur d'un AUTRE COFFRE (autre clé maîtresse) est refusé par le sceau", async () => {
  const autreCoffre = await sceller({
    descripteur: descripteurDEpreuve(),
    manifesteV86: MANIFESTE_V86,
    rangeLe: RANGE_LE,
    cle: await deriverCleDeScellementDuDescripteur({
      cleMaitresse: new Uint8Array(32).fill(9),
      identifiantVolume: IDENTIFIANT,
    }),
  });
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: autreCoffre, cle: await cleDe(1) }),
    refus("sceau"),
  );
});

test("un descripteur NON SCELLÉ — le JSON servi, tel quel — est refusé, jamais lu", async () => {
  const brut = new TextEncoder().encode(JSON.stringify(descripteurDEpreuve()));
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: brut, cle: await cleDe(1) }),
    refus("format"),
  );
  const enveloppe = new TextEncoder().encode(
    JSON.stringify({ descripteur: descripteurDEpreuve(), rangeLe: RANGE_LE }),
  );
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: enveloppe, cle: await cleDe(1) }),
    refus("format"),
  );
});

test("une autre VERSION de format (magie) est refusée, même scellée correctement", async () => {
  for (const magie of ["VLTDSC00", "VLTDSC02", "VLTDSC99", "railsbox"]) {
    const octets = (await scelle()).slice();
    octets.set(new TextEncoder().encode(magie), 0);
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }),
      refus("format"),
      magie,
    );
  }
});

test("un fichier tronqué, trop court, vide ou suivi d'octets en trop est refusé par sa forme", async () => {
  const cle = await cleDe(1);
  const original = await scelle();
  const cas = [
    new Uint8Array(0),
    original.subarray(0, 19),
    original.subarray(0, original.byteLength - 1),
    new Uint8Array([...original, 0]),
  ];
  for (const octets of cas) {
    await assert.rejects(ouvrirLeDescripteurScelle({ octets, cle }), refus("format"));
  }
});

test("une longueur annoncée au-delà de la borne est refusée avant tout calcul", async () => {
  const octets = (await scelle()).slice();
  new DataView(octets.buffer).setUint32(16, TAILLE_MAX_DE_LA_CHARGE + 1);
  await assert.rejects(ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }), refus("format"));
});

test("scellé par le bon coffre mais de FORME refusée : refusé aussi (init=/bin/sh, préfixe étranger)", async () => {
  const cle = await cleDe(1);
  const mauvais = descripteurDEpreuve();
  mauvais.boot.cmdline = "root=/dev/sda1 init=/bin/sh";
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: await scelle({ descripteur: mauvais }), cle }),
    refus("contenu"),
  );
  const etranger = descripteurDEpreuve();
  etranger.prefixeDesArtefacts = "/src/";
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets: await scelle({ descripteur: etranger }), cle }),
    refus("contenu"),
  );
});

test("un manifeste v86 de forme refusée est refusé (nom, empreinte, taille)", async () => {
  const cle = await cleDe(1);
  for (const manifesteV86 of [
    {},
    { artifacts: "x" },
    { artifacts: [{ name: "v86.wasm", bytes: 1, sha256: "pas-hex" }] },
    { artifacts: [{ name: "../v86.wasm", bytes: 1, sha256: "8".repeat(64) }] },
    { artifacts: [{ name: "v86.wasm", bytes: -1, sha256: "8".repeat(64) }] },
  ]) {
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets: await scelle({ manifesteV86 }), cle }),
      refus("contenu"),
    );
  }
});

test("la date doit être un entier sûr non négatif au scellement", async () => {
  for (const rangeLe of [-1, 1.5, Number.NaN, "2026"]) {
    await assert.rejects(scelle({ rangeLe }), TypeError);
  }
});

test("le refus ne porte ni la clé, ni le contenu du fichier : un code, une raison", async () => {
  const altere = (await scelle()).slice();
  altere[30] ^= 1;
  try {
    await ouvrirLeDescripteurScelle({ octets: altere, cle: await cleDe(1) });
    assert.fail("aurait dû refuser");
  } catch (erreur) {
    assert.deepEqual(Object.keys(erreur.contexte), ["raison"]);
    assert.ok(!JSON.stringify(erreur).includes("railsbox-vault-reference"));
  }
});

// --- Des fichiers VALIDEMENT scellés, mais hors règle : seule la règle les refuse -----------------

/** Scelle des octets quelconques sous l'étiquette du produit : le sceau est juste, le fichier non. */
async function scellerBrut(avantLeSceau, cle) {
  const sceau = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cle,
      concatener(chainePrefixee(ETIQUETTE_DU_SCELLEMENT), avantLeSceau),
    ),
  );
  return concatener(avantLeSceau, sceau);
}

function enTete({ magie = MAGIE_DU_DESCRIPTEUR_SCELLE, date = BigInt(RANGE_LE), longueur }) {
  const octets = new Uint8Array(EN_TETE_OCTETS);
  octets.set(new TextEncoder().encode(magie), 0);
  const vue = new DataView(octets.buffer);
  vue.setBigUint64(8, date);
  vue.setUint32(16, longueur);
  return octets;
}

const CHARGE = () =>
  new TextEncoder().encode(
    JSON.stringify({ descripteur: descripteurDEpreuve(), manifesteV86: MANIFESTE_V86 }),
  );

test("une AUTRE magie, sceau juste : refusée par la version, pas seulement par le sceau", async () => {
  const charge = CHARGE();
  for (const magie of ["VLTDSC02", "VLTDSC00", "XXXXXXXX"]) {
    const octets = await scellerBrut(
      concatener(enTete({ magie, longueur: charge.byteLength }), charge),
      await cleDe(1),
    );
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }),
      refus("format"),
      magie,
    );
  }
});

test("une charge démesurée, longueur COHÉRENTE avec le fichier : refusée avant le sceau", async () => {
  const charge = new Uint8Array(TAILLE_MAX_DE_LA_CHARGE + 1).fill(0x20);
  const octets = new Uint8Array(EN_TETE_OCTETS + charge.byteLength + TAILLE_DU_SCEAU);
  octets.set(enTete({ longueur: charge.byteLength }), 0);
  octets.set(charge, EN_TETE_OCTETS);
  await assert.rejects(ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }), refus("format"));
});

test("une date au-delà de l'entier sûr, sceau juste : refusée sur son contenu", async () => {
  const charge = CHARGE();
  const octets = await scellerBrut(
    concatener(enTete({ date: 2n ** 60n, longueur: charge.byteLength }), charge),
    await cleDe(1),
  );
  await assert.rejects(
    ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }),
    refus("contenu"),
  );
});

test("une charge qui n'est pas de l'UTF-8 ou pas du JSON, sceau juste : refusée sur son contenu", async () => {
  for (const charge of [
    new Uint8Array([0xff, 0xfe, 0xfd]),
    new TextEncoder().encode("{pas du json"),
  ]) {
    const octets = await scellerBrut(
      concatener(enTete({ longueur: charge.byteLength }), charge),
      await cleDe(1),
    );
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }),
      refus("contenu"),
    );
  }
});

test("une charge sans descripteur ou sans manifeste v86, sceau juste : refusée sur son contenu", async () => {
  for (const objet of [
    { manifesteV86: MANIFESTE_V86 },
    { descripteur: descripteurDEpreuve() },
    null,
    [],
  ]) {
    const charge = new TextEncoder().encode(JSON.stringify(objet));
    const octets = await scellerBrut(
      concatener(enTete({ longueur: charge.byteLength }), charge),
      await cleDe(1),
    );
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }),
      refus("contenu"),
    );
  }
});

test("un fichier qui n'est pas une vue d'octets est refusé par sa forme", async () => {
  for (const octets of [null, undefined, "VLTDSC01", [1, 2, 3]]) {
    await assert.rejects(
      ouvrirLeDescripteurScelle({ octets, cle: await cleDe(1) }),
      refus("format"),
    );
  }
});
