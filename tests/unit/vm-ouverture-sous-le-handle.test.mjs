import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { voisinsDunVolume } from "../../src/vm/opfs-sync-access.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// LE CROCHET `sousLeHandle` de l'ouvreur de volume (#311, tranche C5 du lot C).
//
// L'appelant qui a obtenu sa clé de volume AVANT d'être seul y REVALIDE ce qui la lui a donnée. Ce que
// l'ouvreur doit tenir, et que ce fichier mesure sur le double du support :
//
//  1. le crochet est appelé SOUS le handle exclusif — un second détenteur est refusé pendant qu'il
//     tourne ;
//  2. AVANT toute écriture et tout accès authentifié : le fichier est octet pour octet celui d'avant,
//     et aucun voisin (génération, témoin) n'a été ouvert ;
//  3. un refus du crochet RENDS le handle, relance l'erreur telle quelle, et ne laisse aucun effet —
//     y compris pour un volume qui naît, dont l'en-tête n'est pas posé ;
//  4. sans crochet, rien ne change.

const NOM = "sous-le-handle";
const TAILLE = 8 * SECTOR_SIZE;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

const options = (store, supplement = {}) => ({
  name: NOM,
  size: TAILLE,
  cle: CLE_DE_TEST,
  identifiantVolume: IDENTIFIANT,
  openHandle: store.openHandle,
  transactionnel: false,
  ...supplement,
});

/** Un volume qui EXISTE : créé puis refermé. */
async function volumeExistant() {
  const store = createSyncAccessStore();
  const backend = await openOpfsVolume(options(store));
  await backend.close();
  return store;
}

/** Les voisins du volume — enveloppe exceptée, que ces épreuves ne touchent pas — et leur taille. */
const fichiers = (store) =>
  Object.fromEntries(voisinsDunVolume(NOM).map((nom) => [nom, store.sizeOf(nom)]));

/** Un voisin OUVERT, c'est-à-dire un accès à la génération, au témoin ou au journal. */
const voisinsOuverts = (store) => voisinsDunVolume(NOM).filter((nom) => store.isOpen(nom));

class Revalidation extends Error {
  code = "VAULT_ENVELOPPE_CLE_REFUSEE";
}

test("le crochet tourne SOUS le handle exclusif, avant toute écriture et tout voisin", async () => {
  const store = await volumeExistant();
  const avant = store.snapshot(NOM);
  const voisinsAvant = fichiers(store);
  let appels = 0;
  let occupe = null;
  let identique = null;
  let voisins = null;
  let ouverts = null;
  let lectures = null;
  const lecturesAvant = store.readCount(NOM);

  const backend = await openOpfsVolume(
    options(store, {
      sousLeHandle: async () => {
        appels += 1;
        occupe = await store.openHandle(NOM).then(
          () => false,
          () => true,
        );
        identique = Buffer.compare(Buffer.from(store.snapshot(NOM)), Buffer.from(avant)) === 0;
        voisins = fichiers(store);
        ouverts = voisinsOuverts(store);
        lectures = store.readCount(NOM) - lecturesAvant;
      },
    }),
  );
  await backend.close();

  assert.equal(appels, 1, "le crochet est appelé une fois");
  assert.equal(
    occupe,
    true,
    "un second détenteur est refusé pendant le crochet : le handle est tenu",
  );
  assert.equal(identique, true, "aucun octet du volume n'a changé avant le crochet");
  assert.deepEqual(voisins, voisinsAvant, "aucun voisin n'a changé avant le crochet");
  assert.deepEqual(ouverts, [], "aucun voisin (génération, témoin) n'est ouvert avant le crochet");
  assert.equal(lectures, 1, "une seule lecture avant le crochet : l'en-tête, qui est public");
});

test("un refus du crochet RENDS le handle, relance l'erreur telle quelle, ne change aucun octet", async () => {
  const store = await volumeExistant();
  const avant = Buffer.from(store.snapshot(NOM));
  const voisinsAvant = fichiers(store);
  const refus = new Revalidation("clé révoquée");

  await assert.rejects(
    openOpfsVolume(
      options(store, {
        sousLeHandle: async () => {
          throw refus;
        },
      }),
    ),
    (erreur) => erreur === refus,
  );

  assert.equal(Buffer.compare(Buffer.from(store.snapshot(NOM)), avant), 0, "volume intact");
  assert.deepEqual(fichiers(store), voisinsAvant, "aucun voisin créé");
  // Le handle est rendu : le volume s'ouvre ensuite, et le registre du processus est libre.
  const rouvert = await openOpfsVolume(options(store));
  await rouvert.close();
});

test("un refus du crochet sur un volume qui NAÎT ne pose ni en-tête ni voisin", async () => {
  const store = createSyncAccessStore();
  await assert.rejects(
    openOpfsVolume(
      options(store, {
        sousLeHandle: async () => {
          throw new Revalidation("clé révoquée");
        },
      }),
    ),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_CLE_REFUSEE",
  );
  assert.equal(
    store.sizeOf(NOM),
    0,
    "l'en-tête n'a pas été posé : le crochet précède la naissance",
  );
  assert.deepEqual(
    Object.values(fichiers(store)).filter((taille) => taille > 0),
    [],
    "aucun voisin n'a reçu d'octet",
  );
  // La naissance reste possible ensuite.
  const backend = await openOpfsVolume(options(store));
  await backend.close();
});

test("sans crochet, l'ouverture est celle d'avant", async () => {
  const store = await volumeExistant();
  const backend = await openOpfsVolume(options(store));
  assert.equal(backend.size(), TAILLE);
  await backend.close();
  await assert.rejects(
    openOpfsVolume({ ...options(store), cle: undefined }),
    (erreur) => isStorageError(erreur) && erreur.code === STORAGE_ERROR_CODES.cleRequise,
  );
});
