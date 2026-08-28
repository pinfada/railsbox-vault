// Un volume v3 dont le SCELLEMENT INITIAL n'est pas allé au bout (#18, ADR 0016, décision 2).
//
// La création d'un volume v3 n'est pas un `truncate` : « un secteur jamais écrit n'existe pas en
// v3 », donc elle scelle TOUS les secteurs, y compris ceux qui ne portent que des zéros. Pour
// 512 Mio, la revue de #102 a chronométré cette fenêtre à 87,6 s. Une coupure qui tombe dedans
// laisse un fichier qui a l'air d'un volume — en-tête posé, taille support allouée — et dont la
// moitié de la région d'authentification est encore à zéro.
//
// Ce que ces épreuves fixent : ce fichier-là ne se rouvre PAS. Le laisser s'ouvrir rendait un
// volume dont chaque secteur non scellé refuse définitivement à la lecture, sous un code qui
// oriente vers la restauration d'une sauvegarde — d'un volume qui n'a jamais servi.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import {
  MARQUEUR_SCELLEMENT_COMPLET,
  SCEAU_OCTETS,
  SCELLEMENT_COMPLET_OFFSET,
  dispositionV3,
} from "../../src/vm/volume-chiffre-format.mjs";

/** 1 024 secteurs : deux tours de scellement, donc une coupure POSSIBLE entre les deux. */
const TAILLE = 1024 * SECTOR_SIZE;

/** Secteurs scellés par tour, tels que `VolumeChiffre.scellerTout` les groupe. */
const PAR_TOUR = 512;

/**
 * Enveloppe le support pour que la n-ième écriture ÉCHOUE, et que les suivantes n'aient pas lieu.
 *
 * Le double ne sait pas tuer un processus au milieu d'un `write`, et il n'en a pas besoin : ce
 * qu'on veut observer n'est pas la manière dont la création meurt, c'est l'ÉTAT qu'elle laisse —
 * un fichier alloué, un en-tête posé, une région à moitié scellée.
 */
function supportQuiCedeALEcriture(store, rang) {
  let vues = 0;
  return async (nom) => {
    const handle = await store.openHandle(nom);
    return {
      getSize: () => handle.getSize(),
      read: (cible, options) => handle.read(cible, options),
      truncate: (taille) => handle.truncate(taille),
      flush: () => handle.flush(),
      close: () => handle.close(),
      write(source, options) {
        vues += 1;
        if (vues === rang) {
          throw new DOMException(
            `Écriture n° ${rang} du volume « ${nom} » interrompue.`,
            "QuotaExceededError",
          );
        }
        return handle.write(source, options);
      },
    };
  };
}

/**
 * Crée un volume dont le scellement initial cède à la QUATRIÈME écriture.
 *
 * Ordre des écritures d'une création : l'en-tête, puis, pour chaque tour, la charge puis les
 * sceaux. Céder à la quatrième laisse le premier tour scellé et le second intact.
 */
async function creationInterrompue(store, nom) {
  await assert.rejects(() =>
    openOpfsVolume({
      name: nom,
      size: TAILLE,
      cle: CLE_DE_TEST,
      openHandle: supportQuiCedeALEcriture(store, 4),
      transactionnel: false,
    }),
  );
}

/** Relit le fichier tel quel, par un handle emprunté au double. */
async function lireFichier(store, nom, offset, longueur) {
  const handle = await store.openHandle(nom);
  try {
    const cible = new Uint8Array(longueur);
    handle.read(cible, { at: offset });
    return cible;
  } finally {
    handle.close();
  }
}

test("une création interrompue laisse bien une région à MOITIÉ scellée", async () => {
  const store = createSyncAccessStore();
  await creationInterrompue(store, "mi-scelle");

  const disposition = dispositionV3(TAILLE);
  assert.equal(
    store.sizeOf("mi-scelle"),
    disposition.tailleSupport,
    "le fichier est alloué : rien ne le distingue d'un volume, à la région près",
  );
  const region = await lireFichier(
    store,
    "mi-scelle",
    disposition.regionOffset,
    disposition.regionOctets,
  );
  const premierTour = region.subarray(0, PAR_TOUR * SCEAU_OCTETS);
  const secondTour = region.subarray(PAR_TOUR * SCEAU_OCTETS, 2 * PAR_TOUR * SCEAU_OCTETS);
  assert.ok(
    premierTour.some((octet) => octet !== 0),
    "le premier tour de scellement a bien atteint le support",
  );
  assert.ok(
    secondTour.every((octet) => octet === 0),
    "le second n'a rien écrit : c'est l'état qu'une coupure laisse",
  );
});

test("un volume dont le scellement initial n'a pas abouti est REFUSÉ à la réouverture", async () => {
  const store = createSyncAccessStore();
  await creationInterrompue(store, "mi-scelle");

  await assert.rejects(
    () =>
      openOpfsVolume({
        name: "mi-scelle",
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
        transactionnel: false,
      }),
    (erreur) => {
      assert.ok(isStorageError(erreur), "un refus typé, pas une exception de circonstance");
      assert.equal(erreur.code, STORAGE_ERROR_CODES.volumeIncomplet);
      assert.match(
        erreur.message,
        /n'a jamais port/i,
        "le remède nommé est le bon : ce volume n'a jamais servi, il se recrée",
      );
      return true;
    },
  );
});

test("la marque de scellement complet n'est posée qu'APRÈS le dernier secteur", async () => {
  const store = createSyncAccessStore();
  await creationInterrompue(store, "mi-scelle");
  const interrompu = await lireFichier(
    store,
    "mi-scelle",
    SCELLEMENT_COMPLET_OFFSET,
    MARQUEUR_SCELLEMENT_COMPLET.byteLength,
  );
  assert.ok(
    interrompu.every((octet) => octet === 0),
    "une création interrompue ne laisse aucune marque : la réserve est restée à zéro",
  );

  const backend = await openOpfsVolume({
    name: "complet",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await backend.close();
  const abouti = await lireFichier(
    store,
    "complet",
    SCELLEMENT_COMPLET_OFFSET,
    MARQUEUR_SCELLEMENT_COMPLET.byteLength,
  );
  assert.deepEqual(abouti, MARQUEUR_SCELLEMENT_COMPLET);

  // Et le volume abouti se rouvre, lui : le contrôle refuse l'inachevé, pas l'achevé.
  const relu = await openOpfsVolume({
    name: "complet",
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  assert.equal(relu.size(), TAILLE);
  await relu.close();
});

test("la marque est un MOTIF, pas un bit : des octets quelconques ne la fabriquent pas", async () => {
  const store = createSyncAccessStore();
  await creationInterrompue(store, "mi-scelle");

  // Un support qui rendrait des `0xff` — ce que certains supports rendent d'une page jamais
  // écrite — ne doit pas faire passer un volume inachevé pour un volume complet. Un drapeau d'un
  // seul bit l'aurait fait.
  const handle = await store.openHandle("mi-scelle");
  handle.write(new Uint8Array(MARQUEUR_SCELLEMENT_COMPLET.byteLength).fill(0xff), {
    at: SCELLEMENT_COMPLET_OFFSET,
  });
  handle.close();

  await assert.rejects(
    () =>
      openOpfsVolume({
        name: "mi-scelle",
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
        transactionnel: false,
      }),
    (erreur) => erreur.code === STORAGE_ERROR_CODES.volumeIncomplet,
  );
});
