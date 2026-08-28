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
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
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
