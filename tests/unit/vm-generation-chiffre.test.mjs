// Le journal de génération au format v3 : enregistrements et racine SCELLÉS (#18, ADR 0016).
//
// Ce fichier porte la CORRECTION de l'ADR 0015 et sa démonstration. L'ADR 0015 écrit qu'un
// enregistrement de journal n'a pas à stocker sa génération, « puisqu'elle est celle de la racine ».
// C'est faux contre `generation-store.mjs` : le journal n'est vidé qu'au POINT DE CONTRÔLE, si bien
// que plusieurs validations s'accumulent sur la même charge et que la dernière racine scelle des
// enregistrements déposés sous des générations antérieures à la sienne. L'épreuve
// « deux validations sans point de contrôle » ci-dessous rejoue le cas sur le magasin RÉEL : sans la
// génération dans le sceau, la réouverture refuse une génération pourtant valide.
//
// Le reste éprouve ce que la racine v3 remplace : le CRC-32 disparaît, l'étiquette prend sa place,
// et une racine altérée refuse la génération au lieu d'être recalculée par qui l'a abîmée.

import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { hexEnOctets } from "../../src/vm/format-chiffre/octets.mjs";
import {
  GENERATION_FORMAT,
  RACINE_ENTETE_OCTETS,
  SCEAU_ENREGISTREMENT_OCTETS,
  offsetDeRacine,
} from "../../src/vm/generation-format.mjs";
import { GENERATION_ETATS, GenerationStore } from "../../src/vm/generation-store.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";

const TAILLE_VOLUME = 32 * 512;
const IDENTIFIANT = "1".repeat(32);

function creerSupport(tailleVolume = TAILLE_VOLUME) {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(tailleVolume);
  return {
    magasin,
    volume,
    tailleVolume,
    lireVolume: async (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: async (offset, octets) => {
      volume.set(octets, offset);
    },
    barriereVolume: async () => {},
  };
}

async function ouvrirMagasin(support, nom = "vol.gen", reste = {}) {
  return GenerationStore.ouvrir({
    volume: "vol",
    handle: await support.magasin.openHandle(nom),
    tailleVolume: support.tailleVolume,
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT,
      cleOctets: CLE_DE_TEST,
      formatVersion: 3,
    }),
    // La fraîcheur de l'ADR 0019 est DÉCLARÉE absente : ce banc n'ouvre pas un volume v3 complet et
    // n'a donc ni région d'authentification ni voisin où poser un témoin. Elle est éprouvée par
    // `vm-generation-fraicheur.test.mjs`, sur le chemin de production.
    fraicheur: null,
    ...reste,
    lireVolume: support.lireVolume,
    ecrireVolume: support.ecrireVolume,
    barriereVolume: support.barriereVolume,
  });
}

test("le format du journal passe à 4, et sa racine occupe toujours 202 octets", () => {
  // #18 avait porté le format de 1 à 2 et la racine à 136 octets ; #19 l'a porté à 3 et la racine à
  // 202, en logeant la fraîcheur de région dans la réserve du même secteur — ce que l'ADR 0016 avait
  // prévu et nommé. #143 le porte à 4 SANS toucher un octet de la racine : ce qui change est
  // l'étiquette de domaine des enregistrements de la charge, et le numéro qui l'annonce.
  assert.equal(
    GENERATION_FORMAT,
    4,
    "un runtime antérieur doit refuser cette racine comme format inconnu",
  );
  assert.equal(RACINE_ENTETE_OCTETS, 202);
  assert.equal(SCEAU_ENREGISTREMENT_OCTETS, 34, "même sceau que la région du volume");
});

test("la racine v3 ne porte plus de CRC-32 : l'étiquette a pris sa place", async () => {
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support);
  await magasin.deposer(0, buildPattern(512, 11));
  await magasin.valider();
  support.magasin.abandon("vol.gen");

  const handle = await support.magasin.openHandle("vol.gen");
  const secteur = new Uint8Array(512);
  handle.read(secteur, { at: offsetDeRacine(1) });
  handle.close();

  // Les seize derniers octets de l'en-tête sont l'étiquette : elle ne peut pas être une somme de
  // contrôle recalculable, sinon un altérateur la reproduirait.
  const etiquette = secteur.subarray(120, 136);
  assert.notDeepEqual(etiquette, new Uint8Array(16), "l'étiquette n'est pas nulle");
  assert.deepEqual(
    secteur.subarray(RACINE_ENTETE_OCTETS),
    new Uint8Array(512 - RACINE_ENTETE_OCTETS),
    "la réserve du secteur de racine reste à zéro",
  );
});

test("DEUX validations sans point de contrôle se rejouent : l'enregistrement porte SA génération", async () => {
  // C'est la correction de l'ADR 0015, rejouée sur le magasin réel. La première génération est
  // validée, la seconde aussi, sans que le journal ait été vidé entre les deux — le seuil du point
  // de contrôle n'est pas atteint. La racine finale porte la génération 2 ; le premier
  // enregistrement, lui, a été scellé sous la génération 1.
  const support = creerSupport();
  const premier = buildPattern(512, 100);
  const second = buildPattern(512, 200);

  const magasin = await ouvrirMagasin(support, "vol.gen", { seuilPointDeControle: 1024 * 1024 });
  await magasin.deposer(0, premier);
  assert.equal(await magasin.valider(), 1);
  await magasin.deposer(512, second);
  assert.equal(await magasin.valider(), 2);
  support.magasin.abandon("vol.gen");

  const relu = await ouvrirMagasin(support);
  assert.equal(relu.rapport.etat, GENERATION_ETATS.rejouee, relu.rapport.code ?? "");
  assert.equal(relu.rapport.enregistrementsRejoues, 2);
  assert.deepEqual([...support.volume.subarray(0, 512)], [...premier]);
  assert.deepEqual([...support.volume.subarray(512, 1024)], [...second]);
});

test("une RACINE altérée refuse la génération, elle ne la répare pas", async () => {
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support);
  await magasin.deposer(0, buildPattern(512, 300));
  await magasin.valider();
  support.magasin.abandon("vol.gen");

  const handle = await support.magasin.openHandle("vol.gen");
  const secteur = new Uint8Array(512);
  handle.read(secteur, { at: offsetDeRacine(1) });
  secteur[125] ^= 0x01; // un octet de l'étiquette
  handle.write(secteur, { at: offsetDeRacine(1) });
  handle.flush();
  handle.close();

  // L'en-tête de la racine se DÉCODE encore : marqueur, format et taille de volume sont intacts, et
  // rien ne peut les contredire sans la clé. Ce qui refuse est l'ÉTIQUETTE, et le code le dit — la
  // cause n'est pas établie, parce qu'un octet retourné et une racine d'un autre volume produisent
  // le même verdict (ADR 0015, ADR 0016 décision 9).
  await assert.rejects(
    () => ouvrirMagasin(support),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("un ENREGISTREMENT altéré refuse la génération entière, jamais à moitié", async () => {
  const support = creerSupport();
  const ancien = buildPattern(512, 400);
  support.volume.set(ancien, 0);

  const magasin = await ouvrirMagasin(support);
  await magasin.deposer(0, buildPattern(512, 500));
  await magasin.valider();
  support.magasin.abandon("vol.gen");

  const handle = await support.magasin.openHandle("vol.gen");
  const octet = new Uint8Array(1);
  const position = 2 * 4096 + 16 + SCEAU_ENREGISTREMENT_OCTETS + 40;
  handle.read(octet, { at: position });
  octet[0] ^= 0x01;
  handle.write(octet, { at: position });
  handle.flush();
  handle.close();

  await assert.rejects(
    () => ouvrirMagasin(support),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
  assert.deepEqual(
    [...support.volume.subarray(0, 512)],
    [...ancien],
    "le volume n'a pas reçu la moitié d'une génération refusée",
  );
});

test("une clé ÉTRANGÈRE ne rouvre pas un journal : le refus est le sceau, pas une comparaison", async () => {
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support);
  await magasin.deposer(0, buildPattern(512, 600));
  await magasin.valider();
  support.magasin.abandon("vol.gen");

  const autre = hexEnOctets("ff".repeat(32));
  await assert.rejects(
    async () =>
      GenerationStore.ouvrir({
        volume: "vol",
        handle: await support.magasin.openHandle("vol.gen"),
        tailleVolume: support.tailleVolume,
        scellement: await Scellement.ouvrir({
          volume: IDENTIFIANT,
          cleOctets: autre,
          formatVersion: 3,
        }),
        fraicheur: null,
        lireVolume: support.lireVolume,
        ecrireVolume: support.ecrireVolume,
        barriereVolume: support.barriereVolume,
      }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("le compteur de scellements de la racine COMPTE les racines et les enregistrements", async () => {
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support, "vol.gen", { seuilPointDeControle: 1024 * 1024 });
  const avant = magasin.scellementsCumules;
  await magasin.deposer(0, buildPattern(512, 700));
  await magasin.valider();
  // Un dépôt et une racine : deux scellements au moins. La racine vide du vidage en ajoute
  // d'autres, et c'est justement ce que le § 8.3 de SP 800-38D demande de compter.
  assert.ok(magasin.scellementsCumules >= avant + 2, `${magasin.scellementsCumules} vs ${avant}`);
});

test("une racine VIDE est authentifiée elle aussi : c'est elle qui fixe la génération", async () => {
  // Une racine vide n'a aucune charge à confronter, et c'est justement ce qui la rend dangereuse :
  // elle fixe à elle seule la génération et la séquence de la session à venir. En v2, `decoderRacine`
  // la validait par un CRC-32 — c'est-à-dire par rien, contre un altérateur qui le recalcule. Une
  // racine vide FORGÉE, de séquence plus haute, aurait alors fait autorité et écarté la vraie.
  //
  // L'épreuve la forge sans clé : un en-tête plausible, un sceau de zéros. Elle doit être refusée.
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support);
  await magasin.deposer(0, buildPattern(512, 800));
  await magasin.valider();
  await magasin.pointDeControle();
  support.magasin.abandon("vol.gen");

  // Témoin positif : la racine vide que le point de contrôle vient d'écrire se rouvre.
  const relu = await ouvrirMagasin(support);
  assert.equal(relu.rapport.etat, GENERATION_ETATS.aucune);
  support.magasin.abandon("vol.gen");

  // Puis la forgerie : même en-tête, séquence relevée, sceau de zéros.
  const handle = await support.magasin.openHandle("vol.gen");
  const secteur = new Uint8Array(512);
  handle.read(secteur, { at: offsetDeRacine(relu.rapport.sequence % 2) });
  const vue = new DataView(secteur.buffer);
  vue.setUint32(16, relu.rapport.sequence + 4, true);
  secteur.fill(0, 76, RACINE_ENTETE_OCTETS);
  handle.write(secteur, { at: offsetDeRacine((relu.rapport.sequence + 4) % 2) });
  handle.flush();
  handle.close();

  await assert.rejects(
    () => ouvrirMagasin(support),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
    "une racine vide forgée ne doit pas faire autorité",
  );
});
