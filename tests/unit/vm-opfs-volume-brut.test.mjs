// ACCÈS BRUT au fichier d'un volume (#101, ADR 0016, décision 7).
//
// L'export d'une archive et la restauration inter-origine manipulent un FICHIER, pas un volume
// logique : l'un le lit octet pour octet, l'autre le recopie octet pour octet, et **ni l'un ni
// l'autre n'a besoin de la clé**. Passer par le backend chiffré leur ferait faire l'inverse de ce
// qu'on attend — déchiffrer à l'export, rechiffrer à la restauration —, ce que la tranche (a)
// refusait faute d'avoir cette porte.
//
// Ce que cet accès N'EST PAS : un contournement du chiffrement. Il ne rend jamais de clair d'un
// volume v3 — les octets qu'il rend SONT les octets chiffrés du support. Il ne sait ni ouvrir un
// secteur, ni valider un sceau, ni interpréter un en-tête. C'est un tuyau, et sa seule discipline
// est celle du support : exclusivité, géométrie, comptes interprétés.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { ouvrirVolumeBrut } from "../../src/vm/opfs-volume-brut.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { tailleSupportV3 } from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE_LOGIQUE = 8 * SECTOR_SIZE;

function motif(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 13 + graine) % 256);
}

test("un volume neuf s'alloue à la taille demandée, et se relit octet pour octet", async () => {
  const magasin = createSyncAccessStore();
  const brut = await ouvrirVolumeBrut({
    name: "brut-neuf",
    size: 4096,
    openHandle: magasin.openHandle,
  });
  try {
    assert.equal(brut.size(), 4096);
    await brut.write(512, motif(1024, 3));
    await brut.flush();
    assert.deepEqual([...(await brut.read(512, 1024))], [...motif(1024, 3)]);
  } finally {
    await brut.close();
  }
  assert.equal(magasin.sizeOf("brut-neuf"), 4096);
});

test("il rend les octets CHIFFRÉS d'un volume v3, et n'en ouvre aucun secteur", async () => {
  // La propriété qui compte : ce que l'accès brut rend n'est pas le clair. Un volume v3 dont un
  // secteur porte un motif connu ne le rend PAS à la lecture brute — sinon l'archive serait en clair,
  // et le refus de la tranche (a) aurait eu raison contre cette tranche-ci.
  const magasin = createSyncAccessStore();
  const clair = motif(SECTOR_SIZE, 9);
  const backend = await openOpfsVolume({
    name: "brut-v3",
    size: TAILLE_LOGIQUE,
    cle: CLE_DE_TEST,
    openHandle: magasin.openHandle,
  });
  await backend.write(0, clair);
  await backend.flush();
  await backend.close();

  const brut = await ouvrirVolumeBrut({ name: "brut-v3", openHandle: magasin.openHandle });
  try {
    assert.equal(
      brut.size(),
      tailleSupportV3(TAILLE_LOGIQUE),
      "l'accès brut voit le FICHIER, pas le volume logique",
    );
    const fichier = await brut.read(0, brut.size());
    assert.equal(
      fichier.includes(clair[0]) && indexOfSuite(fichier, clair) === -1,
      true,
      "le clair du secteur n'apparaît nulle part dans le fichier",
    );
  } finally {
    await brut.close();
  }
});

test("la taille déclarée d'un volume EXISTANT doit correspondre : jamais de retaillage silencieux", async () => {
  const magasin = createSyncAccessStore();
  const premier = await ouvrirVolumeBrut({
    name: "brut-geo",
    size: 4096,
    openHandle: magasin.openHandle,
  });
  await premier.close();

  await assert.rejects(
    () => ouvrirVolumeBrut({ name: "brut-geo", size: 8192, openHandle: magasin.openHandle }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch),
  );
  assert.equal(magasin.sizeOf("brut-geo"), 4096, "le fichier n'a pas été retaillé");
});

test("l'exclusivité est celle du registre : deux détenteurs ne coexistent pas", async () => {
  const magasin = createSyncAccessStore();
  const premier = await ouvrirVolumeBrut({
    name: "brut-exclusif",
    size: 4096,
    openHandle: magasin.openHandle,
  });
  try {
    await assert.rejects(
      () => ouvrirVolumeBrut({ name: "brut-exclusif", size: 4096, openHandle: magasin.openHandle }),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
    );
    // Et l'ouvreur CHIFFRÉ non plus : les deux partagent le même registre, sinon un export et un
    // boot pourraient détenir le même volume et se marcher dessus.
    await assert.rejects(
      () =>
        openOpfsVolume({
          name: "brut-exclusif",
          size: 4096,
          cle: CLE_DE_TEST,
          openHandle: magasin.openHandle,
        }),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
    );
  } finally {
    await premier.close();
  }
  // La fermeture rend le nom : la réouverture doit aboutir.
  const second = await ouvrirVolumeBrut({ name: "brut-exclusif", openHandle: magasin.openHandle });
  await second.close();
});

test("un compte de support inexact est un échec TYPÉ, jamais une lecture courte silencieuse", async () => {
  const magasin = createSyncAccessStore();
  const brut = await ouvrirVolumeBrut({
    name: "brut-court",
    size: 4096,
    openHandle: magasin.openHandle,
  });
  try {
    magasin.plafonnerEcriture(64);
    await assert.rejects(
      () => brut.write(0, motif(512, 1)),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.partialWrite),
    );
  } finally {
    await brut.close();
  }
});

/** Position de la suite `aiguille` dans `botte`, ou -1. Naïf : les tailles sont petites. */
function indexOfSuite(botte, aiguille) {
  for (let debut = 0; debut + aiguille.length <= botte.length; debut += 1) {
    let egal = true;
    for (let index = 0; index < aiguille.length && egal; index += 1) {
      if (botte[debut + index] !== aiguille[index]) egal = false;
    }
    if (egal) return debut;
  }
  return -1;
}
