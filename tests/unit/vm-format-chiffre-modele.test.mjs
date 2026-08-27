import assert from "node:assert/strict";
import test from "node:test";

import {
  CRYPTO_ERROR_CODES,
  MENACES,
  isCryptoError,
} from "../../src/vm/format-chiffre/crypto-errors.mjs";
import { BUDGET_SCELLEMENTS_PAR_CLE } from "../../src/vm/format-chiffre/identite-logique.mjs";
import {
  importerCleDeVolume,
  ouvrirBloc,
  ouvrirRacine,
  scellerBloc,
  scellerRacine,
} from "../../src/vm/format-chiffre/modele-reference.mjs";

// Modèle de référence du format chiffré (#17, ADR 0015).
//
// Cinq menaces, cinq propriétés, cinq refus. Chaque refus est doublé d'un TÉMOIN POSITIF : sans lui,
// un modèle qui refuserait tout passerait pour sûr. C'est la règle que le dépôt s'applique depuis
// `tests/browser/origin-topology.spec.mjs`, et elle vaut ici plus qu'ailleurs — refuser est facile,
// refuser EXACTEMENT ce qu'il faut est la propriété.
//
// Ce que ces épreuves NE prouvent pas est écrit dans l'ADR 0015 : rien ici ne dit qu'AES-256-GCM est
// sûr, ni que l'implémentation WebCrypto du moteur est correcte. Elles prouvent que le modèle LIE ce
// qu'il annonce lier, et qu'il refuse au lieu de deviner.

/** Clé de TEST, publique et volontairement sans entropie : 0x00 à 0x1f. Jamais un secret. */
const CLE_DE_TEST = Uint8Array.from({ length: 32 }, (_, index) => index);

const VOLUME = "volume-de-test";
const FORMAT = 3;
const TAILLE_VOLUME = 16384;

/** Contenu déterministe d'un secteur : `octet i = (i * 7 + 13) mod 256`. */
function secteur(graine = 0) {
  return Uint8Array.from({ length: 512 }, (_, index) => (index * 7 + 13 + graine) % 256);
}

function identiteBloc({ generation, rang, adresse }) {
  return { volume: VOLUME, formatVersion: FORMAT, generation, rang, adresse, longueur: 512 };
}

/** Scelle une génération complète et rend ses blocs, sa racine et l'entrée de chacun. */
async function scellerGeneration(cle, { generation, sequence, adresses, scellementsCumules = 0 }) {
  const blocs = [];
  for (const [rang, adresse] of adresses.entries()) {
    const identite = identiteBloc({ generation, rang, adresse });
    const scelle = await scellerBloc({ cle, identite, contenu: secteur(generation * 3 + rang) });
    blocs.push({ identite, scelle });
  }
  const entrees = blocs.map(({ identite, scelle }) => ({
    adresse: identite.adresse,
    longueur: identite.longueur,
    rang: identite.rang,
    etiquette: scelle.etiquette,
  }));
  const racine = await scellerRacine({
    cle,
    racine: {
      volume: VOLUME,
      formatVersion: FORMAT,
      sequence,
      generation,
      tailleVolume: TAILLE_VOLUME,
      scellementsCumules: scellementsCumules + blocs.length + 1,
    },
    entrees,
  });
  return { blocs, entrees, racine };
}

function attentesRacine(sequenceMinimale = 0) {
  return { volume: VOLUME, formatVersion: FORMAT, tailleVolume: TAILLE_VOLUME, sequenceMinimale };
}

async function cleDeTest() {
  return importerCleDeVolume(CLE_DE_TEST);
}

// ---------------------------------------------------------------------------------------------
// Témoins positifs — une propriété chacun
// ---------------------------------------------------------------------------------------------

test("P1 positif — un bloc scellé puis ouvert rend EXACTEMENT le clair d'origine", async () => {
  const cle = await cleDeTest();
  const identite = identiteBloc({ generation: 1, rang: 0, adresse: 512 });
  const contenu = secteur(1);

  const scelle = await scellerBloc({ cle, identite, contenu });
  assert.notEqual(
    Buffer.from(scelle.chiffre).toString("hex"),
    Buffer.from(contenu).toString("hex"),
    "le chiffré ne doit pas être le clair",
  );

  const ouvert = await ouvrirBloc({ cle, identite, scelle });
  assert.deepEqual(Array.from(ouvert), Array.from(contenu));
});

test("P2 positif — le même chiffré s'ouvre sous SON identité logique, et sous elle seule", async () => {
  const cle = await cleDeTest();
  const identite = identiteBloc({ generation: 2, rang: 4, adresse: 2048 });
  const scelle = await scellerBloc({ cle, identite, contenu: secteur(2) });

  const ouvert = await ouvrirBloc({ cle, identite, scelle });
  assert.equal(ouvert.byteLength, 512);
});

test("P3 positif — une racine dont la séquence dépasse le minimum connu est acceptée", async () => {
  const cle = await cleDeTest();
  const { entrees, racine } = await scellerGeneration(cle, {
    generation: 5,
    sequence: 9,
    adresses: [0, 512],
  });

  const ouverte = await ouvrirRacine({
    cle,
    entete: racine.entete,
    scelle: racine,
    entrees,
    attentes: attentesRacine(8),
  });
  assert.equal(ouverte.entete.sequence, 9);
  assert.equal(ouverte.entete.generation, 5);
  assert.equal(ouverte.entete.nombreEntrees, 2);
});

test("P4 positif — une racine s'ouvre sur l'ensemble EXACT des entrées qu'elle scelle", async () => {
  const cle = await cleDeTest();
  const { entrees, racine } = await scellerGeneration(cle, {
    generation: 6,
    sequence: 10,
    adresses: [0, 512, 1024, 1536],
  });

  const ouverte = await ouvrirRacine({
    cle,
    entete: racine.entete,
    scelle: racine,
    entrees,
    attentes: attentesRacine(),
  });
  assert.equal(ouverte.entete.nombreEntrees, 4);
  assert.equal(ouverte.entete.longueurCharge, 4 * 512);
});

test("P5 positif — deux générations distinctes s'ouvrent chacune sous SA racine", async () => {
  const cle = await cleDeTest();
  const premiere = await scellerGeneration(cle, {
    generation: 7,
    sequence: 11,
    adresses: [0, 512],
  });
  const seconde = await scellerGeneration(cle, { generation: 8, sequence: 12, adresses: [0, 512] });

  for (const { entrees, racine } of [premiere, seconde]) {
    const ouverte = await ouvrirRacine({
      cle,
      entete: racine.entete,
      scelle: racine,
      entrees,
      attentes: attentesRacine(),
    });
    assert.equal(ouverte.entete.nombreEntrees, 2);
  }

  // Et chaque bloc s'ouvre sous l'identité de SA génération.
  for (const { identite, scelle } of [...premiere.blocs, ...seconde.blocs]) {
    assert.equal((await ouvrirBloc({ cle, identite, scelle })).byteLength, 512);
  }
});

// ---------------------------------------------------------------------------------------------
// Cinq menaces, cinq refus
// ---------------------------------------------------------------------------------------------

test("MODIFICATION — un seul octet retourné, où qu'il soit, refuse le sceau", async () => {
  const cle = await cleDeTest();
  const identite = identiteBloc({ generation: 1, rang: 0, adresse: 0 });
  const scelle = await scellerBloc({ cle, identite, contenu: secteur(0) });

  for (const champ of ["chiffre", "etiquette", "nonce"]) {
    for (const position of [0, 1, scelle[champ].byteLength - 1]) {
      const abime = Uint8Array.from(scelle[champ]);
      abime[position] ^= 0x01;
      await assert.rejects(
        () => ouvrirBloc({ cle, identite, scelle: { ...scelle, [champ]: abime } }),
        (erreur) => isCryptoError(erreur) && erreur.menaces.includes(MENACES.modification),
        `l'octet ${position} de « ${champ} » doit invalider le sceau`,
      );
    }
  }
});

test("DÉPLACEMENT — autre adresse, autre volume, autre format, autre génération : refusés", async () => {
  const cle = await cleDeTest();
  const identite = identiteBloc({ generation: 3, rang: 2, adresse: 1024 });
  const scelle = await scellerBloc({ cle, identite, contenu: secteur(3) });

  // Témoin positif d'abord : sans lui, un refus systématique ne prouverait rien.
  assert.equal((await ouvrirBloc({ cle, identite, scelle })).byteLength, 512);

  const deplacements = [
    { ...identite, adresse: 1536 },
    { ...identite, volume: "un-autre-volume" },
    { ...identite, formatVersion: 4 },
    { ...identite, generation: 4 },
  ];
  for (const deplacee of deplacements) {
    await assert.rejects(
      () => ouvrirBloc({ cle, identite: deplacee, scelle }),
      (erreur) => isCryptoError(erreur) && erreur.menaces.includes(MENACES.deplacement),
      `${JSON.stringify(deplacee)} doit être refusé`,
    );
  }
});

test("REJEU — une racine et un bloc d'une génération antérieure, intacts, sont refusés", async () => {
  const cle = await cleDeTest();
  const ancienne = await scellerGeneration(cle, { generation: 4, sequence: 4, adresses: [0, 512] });
  const courante = await scellerGeneration(cle, { generation: 5, sequence: 5, adresses: [0, 512] });

  // La racine courante passe le même contrôle : le refus vise l'ANCIENNETÉ, pas la racine.
  await ouvrirRacine({
    cle,
    entete: courante.racine.entete,
    scelle: courante.racine,
    entrees: courante.entrees,
    attentes: attentesRacine(5),
  });

  await assert.rejects(
    () =>
      ouvrirRacine({
        cle,
        entete: ancienne.racine.entete,
        scelle: ancienne.racine,
        entrees: ancienne.entrees,
        attentes: attentesRacine(5),
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.replay),
  );

  const [premier] = ancienne.blocs;
  await assert.rejects(
    () =>
      ouvrirBloc({
        cle,
        identite: premier.identite,
        scelle: premier.scelle,
        attentes: { generationMinimale: 5 },
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.replay),
  );
});

test("TRONCATURE — une génération à laquelle il manque une entrée est refusée", async () => {
  const cle = await cleDeTest();
  const { entrees, racine } = await scellerGeneration(cle, {
    generation: 9,
    sequence: 20,
    adresses: [0, 512, 1024],
  });

  await assert.rejects(
    () =>
      ouvrirRacine({
        cle,
        entete: racine.entete,
        scelle: racine,
        entrees: entrees.slice(0, 2),
        attentes: attentesRacine(),
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.truncation),
  );

  // Une entrée SURNUMÉRAIRE est la même menace vue de l'autre côté : le compte est authentifié.
  await assert.rejects(
    () =>
      ouvrirRacine({
        cle,
        entete: racine.entete,
        scelle: racine,
        entrees: [...entrees, entrees[0]],
        attentes: attentesRacine(),
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.truncation),
  );
});

test("MÉLANGE — des blocs individuellement valides mais d'une autre génération sont refusés", async () => {
  const cle = await cleDeTest();
  const premiere = await scellerGeneration(cle, {
    generation: 10,
    sequence: 30,
    adresses: [0, 512],
  });
  const seconde = await scellerGeneration(cle, {
    generation: 11,
    sequence: 31,
    adresses: [0, 512],
  });

  // L'entrée substituée est authentique : elle vient d'un bloc réellement scellé par cette clé.
  const melangees = [premiere.entrees[0], seconde.entrees[1]];
  assert.equal(melangees.length, premiere.entrees.length);

  await assert.rejects(
    () =>
      ouvrirRacine({
        cle,
        entete: premiere.racine.entete,
        scelle: premiere.racine,
        entrees: melangees,
        attentes: attentesRacine(),
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.mixing),
  );

  // Réordonner sans rien retirer est la même menace : la racine scelle une SUITE, pas un sac.
  await assert.rejects(
    () =>
      ouvrirRacine({
        cle,
        entete: premiere.racine.entete,
        scelle: premiere.racine,
        entrees: [premiere.entrees[1], premiere.entrees[0]],
        attentes: attentesRacine(),
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.mixing),
  );
});

// ---------------------------------------------------------------------------------------------
// Bornes : ce qui doit être refusé AVANT d'écrire quoi que ce soit
// ---------------------------------------------------------------------------------------------

test("BORNE — deux entrées de même rang sont refusées : ce serait une réutilisation de nonce", async () => {
  const cle = await cleDeTest();
  const { entrees, racine } = await scellerGeneration(cle, {
    generation: 12,
    sequence: 40,
    adresses: [0, 512],
  });

  const doublon = [entrees[0], { ...entrees[1], rang: entrees[0].rang }];
  await assert.rejects(
    () =>
      scellerRacine({
        cle,
        racine: { ...racine.entete, scellementsCumules: racine.entete.scellementsCumules },
        entrees: doublon,
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.nonceReuse),
  );
});

test("BORNE — au budget de scellements de la clé, sceller est refusé avant de produire un nonce", async () => {
  const cle = await cleDeTest();
  const identite = identiteBloc({ generation: 1, rang: 0, adresse: 0 });

  // Juste sous la limite : le scellement passe encore.
  await scellerBloc({
    cle,
    identite,
    contenu: secteur(0),
    attentes: { scellementsCumules: BUDGET_SCELLEMENTS_PAR_CLE - 1 },
  });

  await assert.rejects(
    () =>
      scellerBloc({
        cle,
        identite,
        contenu: secteur(0),
        attentes: { scellementsCumules: BUDGET_SCELLEMENTS_PAR_CLE },
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.keyBudget),
  );

  await assert.rejects(
    () =>
      scellerRacine({
        cle,
        racine: {
          volume: VOLUME,
          formatVersion: FORMAT,
          sequence: 1,
          generation: 1,
          tailleVolume: TAILLE_VOLUME,
          scellementsCumules: BUDGET_SCELLEMENTS_PAR_CLE,
        },
        entrees: [],
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.keyBudget),
  );
});

test("BORNE — une séquence de racine qui ne croît pas strictement est refusée", async () => {
  // La reprise après échec est le cas qui mord : rejouer la MÊME séquence sur une génération dont
  // les entrées ont changé réutiliserait le nonce de la racine. Le modèle ne peut pas le voir seul —
  // il est sans état —, mais il le refuse dès que l'appelant lui présente la séquence précédente.
  const cle = await cleDeTest();
  const racine = {
    volume: VOLUME,
    formatVersion: FORMAT,
    sequence: 7,
    generation: 7,
    tailleVolume: TAILLE_VOLUME,
    scellementsCumules: 12,
  };

  // Témoin positif : strictement au-dessus, le scellement passe.
  await scellerRacine({ cle, racine, entrees: [], attentes: { sequencePrecedente: 6 } });

  for (const sequencePrecedente of [7, 8]) {
    await assert.rejects(
      () => scellerRacine({ cle, racine, entrees: [], attentes: { sequencePrecedente } }),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.nonceReuse),
      `une séquence 7 après ${sequencePrecedente} doit être refusée`,
    );
  }
});

test("BORNE — une racine sans compteur de scellements est refusée, pas comptée pour zéro", async () => {
  const cle = await cleDeTest();
  await assert.rejects(
    () =>
      scellerRacine({
        cle,
        racine: {
          volume: VOLUME,
          formatVersion: FORMAT,
          sequence: 1,
          generation: 1,
          tailleVolume: TAILLE_VOLUME,
        },
        entrees: [],
      }),
    (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.malformed),
    "un compteur absent rendrait le budget de clé muet",
  );
});

test("BORNE — une clé qui n'a pas la bonne longueur est refusée, jamais complétée", async () => {
  for (const longueur of [0, 16, 31, 33]) {
    await assert.rejects(
      () => importerCleDeVolume(new Uint8Array(longueur)),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.malformed),
      `une clé de ${longueur} octets doit être refusée`,
    );
  }
});
