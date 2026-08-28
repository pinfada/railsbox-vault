// FRAÎCHEUR de la région d'authentification, et TÉMOIN de dernière séquence vue (#19, ADR 0019).
//
// L'ADR 0015 nomme deux retours arrière que le format ne détecte pas, et l'ADR 0016 les réinscrit
// dans ses limites : celui d'un SECTEUR du volume, et celui du SUPPORT COMPLET. Ce fichier éprouve
// ce que #19 en ferme, et — c'est aussi important — ce qu'il ne ferme pas.
//
//  - **Le retour arrière d'un secteur est désormais détecté.** Le secteur remis en place reste
//    AUTHENTIQUE : l'épreuve le démontre en l'ouvrant par le chemin non transactionnel, qui ne
//    connaît pas la fraîcheur et rend son clair sans broncher. Ce qui refuse est l'empreinte de la
//    RÉGION, scellée par la dernière racine et confrontée avant toute lecture de secteur.
//  - **Le retour arrière PARTIEL du support est détecté** par le témoin de dernière séquence vue,
//    qui vit hors du fichier de volume et dans la même origine.
//  - **Le retour arrière COMPLET ne l'est pas**, et l'épreuve le MONTRE plutôt que de l'écrire
//    seulement : quand le témoin recule avec le volume et son journal, le volume rouvre. C'est la
//    limite de l'ADR 0019, renvoyée à #21/#23, et aucune formulation ne doit laisser croire l'inverse.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { CRYPTO_ERROR_CODES } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import { GenerationStore } from "../../src/vm/generation-store.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import {
  SCEAU_OCTETS,
  dispositionV3,
  offsetDeCharge,
  offsetDeSceau,
} from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE = 64 * SECTOR_SIZE;
const DISPOSITION = dispositionV3(TAILLE);
/** Identifiant FIXE des bancs de migration : il entre dans les données associées de chaque sceau. */
const IDENTIFIANT_BANC = "3".repeat(32);
let compteur = 0;

function nomNeuf() {
  compteur += 1;
  return `fraicheur-${compteur}`;
}

function ouvrir(magasin, nom, reste = {}) {
  return openOpfsVolume({
    name: nom,
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: magasin.openHandle,
    ...reste,
  });
}

/** Remet un fichier du double dans un état capturé plus tôt. C'est le RETOUR ARRIÈRE du support. */
async function restaurer(magasin, nom, octets) {
  const handle = await magasin.openHandle(nom);
  handle.truncate(0);
  handle.write(octets, { at: 0 });
  handle.flush();
  handle.close();
  magasin.abandon(nom);
}

/** Recopie une plage d'un instantané dans le fichier vivant, sans toucher au reste. */
async function replacer(magasin, nom, source, plages) {
  const handle = await magasin.openHandle(nom);
  for (const [offset, longueur] of plages) {
    handle.write(source.slice(offset, offset + longueur), { at: offset });
  }
  handle.flush();
  handle.close();
  magasin.abandon(nom);
}

test("un SECTEUR ramené en arrière hors journal est refusé, alors que ce secteur reste authentique", async () => {
  const magasin = createSyncAccessStore();
  const nom = nomNeuf();
  const ancien = buildPattern(SECTOR_SIZE, 61);
  const nouveau = buildPattern(SECTOR_SIZE, 62);

  let backend = await ouvrir(magasin, nom);
  await backend.write(0, ancien);
  await backend.flush();
  await backend.close();
  // Le support tel qu'il était : c'est de là que le secteur sera ramené.
  const avant = magasin.snapshot(nom);

  backend = await ouvrir(magasin, nom);
  await backend.write(0, nouveau);
  await backend.flush();
  await backend.close();

  // TÉMOIN POSITIF : sans retour arrière, le volume rouvre et rend le NOUVEAU contenu.
  backend = await ouvrir(magasin, nom);
  assert.deepEqual([...(await backend.read(0, SECTOR_SIZE))], [...nouveau]);
  await backend.close();

  // Le RETOUR ARRIÈRE : le quadruplet complet du secteur 0 — chiffré, nonce, étiquette, génération —
  // est remis dans l'état d'avant. Le journal, lui, n'est pas touché.
  await replacer(magasin, nom, avant, [
    [offsetDeCharge(DISPOSITION, 0), SECTOR_SIZE],
    [offsetDeSceau(DISPOSITION, 0), SCEAU_OCTETS],
  ]);

  // Le secteur ainsi remis en place est AUTHENTIQUE, et l'ADR 0015 dit pourquoi : le lecteur lit sa
  // génération dans la région, au même endroit que son sceau. Le chemin NON TRANSACTIONNEL, qui ne
  // connaît pas la fraîcheur, le rend donc sans broncher — c'est la démonstration que ce qui refuse
  // n'est pas le sceau du secteur.
  const brut = await ouvrir(magasin, nom, { transactionnel: false });
  assert.deepEqual([...(await brut.read(0, SECTOR_SIZE))], [...ancien]);
  await brut.close();

  // Et pourtant l'ouverture TRANSACTIONNELLE refuse : la région relue ne concorde plus avec
  // l'empreinte que la dernière racine scelle.
  await assert.rejects(
    () => ouvrir(magasin, nom),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      String(erreur.context.cause).includes("FRAICHEUR"),
  );
});

test("un volume ramené SOUS le témoin est refusé ; ramené AVEC lui, il ne l'est pas", async () => {
  const magasin = createSyncAccessStore();
  const nom = nomNeuf();
  const journal = `${nom}.gen`;
  const temoin = `${nom}.temoin`;
  const premier = buildPattern(SECTOR_SIZE, 71);
  const second = buildPattern(SECTOR_SIZE, 72);

  let backend = await ouvrir(magasin, nom);
  await backend.write(0, premier);
  await backend.flush();
  await backend.close();

  const etat = {
    volume: magasin.snapshot(nom),
    journal: magasin.snapshot(journal),
    temoin: magasin.snapshot(temoin),
  };
  assert.ok(etat.temoin.byteLength > 0, "le témoin est écrit après la racine et sa barrière");

  backend = await ouvrir(magasin, nom);
  await backend.write(SECTOR_SIZE, second);
  await backend.flush();
  await backend.close();

  // RETOUR ARRIÈRE PARTIEL : le volume et son journal reculent, le témoin reste. C'est exactement le
  // cas que #19 ferme.
  await restaurer(magasin, nom, etat.volume);
  await restaurer(magasin, journal, etat.journal);

  await assert.rejects(
    () => ouvrir(magasin, nom),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      erreur.context.cause === CRYPTO_ERROR_CODES.replay,
  );

  // RETOUR ARRIÈRE COMPLET : le témoin recule lui aussi. Le volume rouvre, et il le doit — un état
  // antérieur cohérent est authentique par construction. Rien dans ce dépôt ne le détecte sans une
  // ancre hors du support (#21/#23), et cette ligne est la preuve que la limite est réelle.
  await restaurer(magasin, temoin, etat.temoin);
  backend = await ouvrir(magasin, nom);
  assert.deepEqual([...(await backend.read(0, SECTOR_SIZE))], [...premier]);
  assert.deepEqual(
    [...(await backend.read(SECTOR_SIZE, SECTOR_SIZE))],
    [...new Uint8Array(SECTOR_SIZE)],
    "la seconde écriture a disparu avec le support, et personne ne peut le voir",
  );
  await backend.close();
});

/**
 * Source de fraîcheur EN MÉMOIRE : une région et un témoin, sans volume v3 complet.
 *
 * Elle sert aux épreuves de COMPATIBILITÉ ci-dessous, qui portent sur la machine d'état du magasin —
 * quelle racine il écrit, ce qu'il confronte, ce qu'il publie — et non sur la disposition du
 * fichier. Celle-ci est éprouvée plus haut, par le chemin de production.
 */
function sourceEnMemoire(region, boite) {
  return {
    regionOffset: 0,
    regionOctets: region.byteLength,
    lireRegion: async (offset, longueur) => region.slice(offset, offset + longueur),
    lireTemoin: async () => boite.octets,
    ecrireTemoin: async (octets) => {
      boite.octets = octets;
    },
  };
}

function bancDeMigration() {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(TAILLE);
  const region = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7 + 3) % 256);
  const boite = { octets: null };
  const ouvrir = async (fraicheur) =>
    GenerationStore.ouvrir({
      volume: "vol",
      handle: await magasin.openHandle("vol.gen"),
      tailleVolume: TAILLE,
      scellement: await Scellement.ouvrir({
        volume: IDENTIFIANT_BANC,
        cleOctets: CLE_DE_TEST,
        formatVersion: 3,
      }),
      fraicheur,
      lireVolume: async (offset, longueur) => volume.slice(offset, offset + longueur),
      ecrireVolume: async (offset, octets) => {
        volume.set(octets, offset);
      },
      barriereVolume: async () => {},
    });
  return { magasin, volume, region, boite, ouvrir };
}

test("un volume scellé par #18 reste OUVRABLE, et migre à la première racine écrite", async () => {
  // C'est la compatibilité que l'ADR 0019 décide, éprouvée plutôt qu'affirmée. Le premier magasin
  // DÉCLARE n'avoir aucune fraîcheur : il écrit donc des racines de format 2, exactement celles que
  // #18 laissait. Le second en a une, et doit ouvrir ce volume sans le refuser.
  const banc = bancDeMigration();

  const avant19 = await banc.ouvrir(null);
  await avant19.deposer(0, buildPattern(SECTOR_SIZE, 81));
  await avant19.valider();
  await avant19.pointDeControle();
  avant19.close();
  banc.magasin.abandon("vol.gen");
  assert.equal(banc.boite.octets, null, "un magasin sans fraîcheur n'écrit aucun témoin");

  // PREMIÈRE ouverture avec fraîcheur : rien à confronter, et le rapport le DIT au lieu de
  // prétendre une vérification. C'est la fenêtre d'une ouverture que l'ADR 0019 nomme.
  const migrant = await banc.ouvrir(sourceEnMemoire(banc.region, banc.boite));
  assert.equal(migrant.rapport.fraicheurRegion, "migree");
  assert.equal(migrant.rapport.temoinSequence, null, "aucun témoin ne précède la migration");
  migrant.close();
  banc.magasin.abandon("vol.gen");
  assert.notEqual(banc.boite.octets, null, "le vidage de la migration a posé un témoin");

  // SECONDE ouverture : la racine écrite entre-temps porte l'empreinte, et elle est confrontée.
  const migre = await banc.ouvrir(sourceEnMemoire(banc.region, banc.boite));
  assert.equal(migre.rapport.fraicheurRegion, "verifiee");
  assert.ok(migre.rapport.temoinSequence > 0, `séquence ${migre.rapport.temoinSequence}`);
  migre.close();
  banc.magasin.abandon("vol.gen");
});

test("une fois la fraîcheur acquise, un retour à une racine SANS empreinte est refusé", async () => {
  // La propriété acquise ne se reperd pas. Sans ce contrôle, l'empreinte serait désarmable en
  // présentant une racine authentique d'avant #19 : le témoin ferme cette porte pour tout ce qui
  // n'est pas un retour arrière complet — qui l'emporterait lui aussi.
  const banc = bancDeMigration();

  const avant19 = await banc.ouvrir(null);
  await avant19.deposer(0, buildPattern(SECTOR_SIZE, 91));
  await avant19.valider();
  await avant19.pointDeControle();
  avant19.close();
  banc.magasin.abandon("vol.gen");
  const journalSansFraicheur = banc.magasin.snapshot("vol.gen");

  const migrant = await banc.ouvrir(sourceEnMemoire(banc.region, banc.boite));
  migrant.close();
  banc.magasin.abandon("vol.gen");

  // TÉMOIN POSITIF : le volume migré se rouvre.
  const migre = await banc.ouvrir(sourceEnMemoire(banc.region, banc.boite));
  assert.equal(migre.rapport.fraicheurRegion, "verifiee");
  migre.close();
  banc.magasin.abandon("vol.gen");

  // Puis le RETOUR au journal d'avant, dont les racines authentiques ne scellent aucune empreinte.
  await restaurer(banc.magasin, "vol.gen", journalSansFraicheur);
  await assert.rejects(
    () => banc.ouvrir(sourceEnMemoire(banc.region, banc.boite)),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      String(erreur.context.cause).includes("FRAICHEUR"),
  );
});

test("une RÉGION qui change sous une racine inchangée est refusée, empreinte à l'appui", async () => {
  const banc = bancDeMigration();
  const source = () => sourceEnMemoire(banc.region, banc.boite);

  const premier = await banc.ouvrir(source());
  await premier.deposer(0, buildPattern(SECTOR_SIZE, 101));
  await premier.valider();
  await premier.pointDeControle();
  premier.close();
  banc.magasin.abandon("vol.gen");

  // TÉMOIN POSITIF : région inchangée, le volume rouvre et la confrontation a bien eu lieu.
  const intact = await banc.ouvrir(source());
  assert.equal(intact.rapport.fraicheurRegion, "verifiee");
  intact.close();
  banc.magasin.abandon("vol.gen");

  // UN SEUL OCTET de la région, et rien d'autre : ni le journal, ni la racine, ni le volume.
  banc.region[1234] ^= 0x01;
  await assert.rejects(
    () => banc.ouvrir(source()),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      String(erreur.context.cause).includes("FRAICHEUR"),
  );
});
