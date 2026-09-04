import assert from "node:assert/strict";
import test from "node:test";

import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { importerCleDeVolume } from "../../src/vm/format-chiffre/modele-reference.mjs";
import {
  INSTANTANE_FORMAT,
  encoderLiaison,
  exigerLiaison,
} from "../../src/vm/instantane/identite-instantane.mjs";
import {
  INSTANTANE_ERROR_CODES,
  isInstantaneError,
} from "../../src/vm/instantane/instantane-errors.mjs";
import {
  ouvrirInstantane,
  scellerInstantaneSousNonce,
} from "../../src/vm/instantane/modele-reference.mjs";

// MODÈLE DE RÉFÉRENCE de l'instantané de reprise (#65, ADR 0024).
//
// Ce fichier éprouve la spécification exécutable, pas le chemin de production : ce que la LIAISON
// encode, ce que l'unique scellement lie, et ce qu'un écart produit. Le chemin de production est
// éprouvé par `vm-instantane-fichier.test.mjs` et `vm-instantane-conduite.test.mjs` ; les octets du
// format sont figés par `vm-instantane-vecteurs.test.mjs`.
//
// La règle qui gouverne chaque cas ci-dessous vient de l'ADR 0024 : les données associées SONT
// l'en-tête. Changer un champ de la liaison, c'est changer les données associées, donc faire échouer
// l'étiquette — et aucun clair n'est rendu. Chaque axe de la liaison est donc éprouvé séparément,
// avec son TÉMOIN POSITIF : la même ouverture, sous la liaison d'origine, doit rendre l'état.

const REGION = Uint8Array.from({ length: 32 }, (_, index) => (index * 3 + 1) % 256);
const IMAGE = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 7) % 256);
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
const ETAT = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7 + 13) % 256);

function liaisonDeReference(remplacements = {}) {
  return {
    volume: "0123456789abcdef0123456789abcdef",
    formatInstantane: INSTANTANE_FORMAT,
    formatVolume: 3,
    sequence: 42,
    generation: 17,
    empreinteRegion: REGION,
    empreinteImage: IMAGE,
    longueurEtat: ETAT.byteLength,
    ...remplacements,
  };
}

async function cle() {
  return importerCleDeVolume(CLE_DE_TEST);
}

async function scelleDeReference() {
  return scellerInstantaneSousNonce({
    cle: await cle(),
    liaison: liaisonDeReference(),
    etat: ETAT,
    nonce: NONCE,
    attentes: { scellementsCumules: 0 },
  });
}

test("la liaison encodée est déterministe et sépare deux champs voisins", () => {
  const gauche = encoderLiaison(liaisonDeReference({ sequence: 1, generation: 2 }));
  const droite = encoderLiaison(liaisonDeReference({ sequence: 2, generation: 1 }));
  assert.notEqual(
    octetsEnHex(gauche),
    octetsEnHex(droite),
    "deux liaisons qui échangent séquence et génération ne doivent pas rendre les mêmes octets",
  );
  assert.equal(
    octetsEnHex(encoderLiaison(liaisonDeReference())),
    octetsEnHex(encoderLiaison(liaisonDeReference())),
    "le même encodage doit rendre les mêmes octets",
  );
});

test("un identifiant de volume dont le préfixe glisse ne collisionne pas", () => {
  // Sans préfixe de longueur, « abc » + « def… » et « abcdef… » + «  » seraient les mêmes octets.
  const court = encoderLiaison(liaisonDeReference({ volume: "0123456789abcdef" }));
  const long = encoderLiaison(liaisonDeReference({ volume: "0123456789abcdef0" }));
  assert.notEqual(octetsEnHex(court), octetsEnHex(long));
});

test("une liaison incomplète est REFUSÉE, jamais complétée", () => {
  for (const champ of [
    "volume",
    "formatVolume",
    "sequence",
    "generation",
    "empreinteRegion",
    "empreinteImage",
    "longueurEtat",
  ]) {
    const liaison = liaisonDeReference();
    delete liaison[champ];
    assert.throws(
      () => exigerLiaison(liaison),
      (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.malforme),
      `« ${champ} » manquant doit être refusé`,
    );
  }
});

test("le scellement rend le clair sous la MÊME liaison — témoin positif", async () => {
  const scelle = await scelleDeReference();
  assert.equal(scelle.nonce.byteLength, 12);
  assert.equal(scelle.etiquette.byteLength, 16);
  assert.equal(scelle.chiffre.byteLength, ETAT.byteLength);

  const rendu = await ouvrirInstantane({
    cle: await cle(),
    liaison: liaisonDeReference(),
    scelle,
  });
  assert.equal(octetsEnHex(rendu), octetsEnHex(ETAT));
});

test("chaque axe de la liaison fait ÉCHOUER l'étiquette, et aucun clair n'est rendu", async () => {
  const scelle = await scelleDeReference();
  const ecarts = {
    volume: "fedcba9876543210fedcba9876543210",
    formatVolume: 4,
    sequence: 43,
    generation: 18,
    empreinteRegion: Uint8Array.from(REGION, (octet) => octet ^ 0x01),
    empreinteImage: Uint8Array.from(IMAGE, (octet) => octet ^ 0x01),
    longueurEtat: ETAT.byteLength + 512,
  };

  for (const [champ, valeur] of Object.entries(ecarts)) {
    await assert.rejects(
      ouvrirInstantane({
        cle: await cle(),
        liaison: liaisonDeReference({ [champ]: valeur }),
        scelle,
      }),
      (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.sceauRefuse),
      `un écart de « ${champ} » doit refuser le sceau`,
    );
  }
});

test("un octet du corps retourné refuse le sceau", async () => {
  const scelle = await scelleDeReference();
  const altere = {
    ...scelle,
    chiffre: Uint8Array.from(scelle.chiffre, (octet, index) => (index === 100 ? octet ^ 1 : octet)),
  };
  await assert.rejects(
    ouvrirInstantane({ cle: await cle(), liaison: liaisonDeReference(), scelle: altere }),
    (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.sceauRefuse),
  );
});

test("une autre clé n'ouvre pas l'instantané", async () => {
  const scelle = await scelleDeReference();
  const autre = await importerCleDeVolume(Uint8Array.from(CLE_DE_TEST, (octet) => octet ^ 0xff));
  await assert.rejects(
    ouvrirInstantane({ cle: autre, liaison: liaisonDeReference(), scelle }),
    (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.sceauRefuse),
  );
});

test("le budget de clé est PRÉSENTÉ, et un oubli est refusé", async () => {
  await assert.rejects(
    scellerInstantaneSousNonce({
      cle: await cle(),
      liaison: liaisonDeReference(),
      etat: ETAT,
      nonce: NONCE,
      attentes: {},
    }),
    (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.malforme),
    "« attentes.scellementsCumules » est obligatoire : un oubli vaudrait un budget non compté",
  );
});

test("le budget de clé épuisé refuse la capture", async () => {
  await assert.rejects(
    scellerInstantaneSousNonce({
      cle: await cle(),
      liaison: liaisonDeReference(),
      etat: ETAT,
      nonce: NONCE,
      attentes: { scellementsCumules: 2 ** 31 },
    }),
    (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.budgetDeCle),
  );
});

test("un état dont la longueur ne correspond pas à la liaison est refusé AVANT de chiffrer", async () => {
  await assert.rejects(
    scellerInstantaneSousNonce({
      cle: await cle(),
      liaison: liaisonDeReference({ longueurEtat: ETAT.byteLength - 1 }),
      etat: ETAT,
      nonce: NONCE,
      attentes: { scellementsCumules: 0 },
    }),
    (erreur) => isInstantaneError(erreur, INSTANTANE_ERROR_CODES.malforme),
    "une longueur devinée n'est pas une longueur",
  );
});
