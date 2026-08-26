import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE, V86_BLOCK_SIZE } from "../../src/vm/block-geometry.mjs";
import { BlockJournal, JOURNAL_OPERATIONS } from "../../src/vm/block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// Tests unitaires du backend de blocs OPFS (#6, `VAULT-PERSIST-001`). Ils utilisent un DOUBLE
// déterministe de `FileSystemSyncAccessHandle` — lui-même vérifié par
// `vm-sync-access-double.test.mjs` — pour rejouer sans navigateur les fautes que le vrai OPFS ne
// produit pas à la demande : quota, handle perdu, écriture partielle, lecture courte.
//
// Ce que ces tests NE prouvent pas : que le vrai OPFS se comporte ainsi. C'est le rôle de
// `tests/browser/opfs-block-backend.spec.mjs`, qui rejoue les mêmes observations sur le vrai
// support, dans un Worker dédié.

const TAILLE = 64 * SECTOR_SIZE;
let compteur = 0;

/**
 * Ouvre un volume adossé à un double neuf, sous un nom jamais réutilisé.
 * `options.store` configure le double (quota, plafond d'écriture), il ne le remplace pas.
 */
async function volume(options = {}) {
  compteur += 1;
  const { store: configuration, ...reste } = options;
  const store = createSyncAccessStore(configuration);
  const journal = reste.journal ?? new BlockJournal();
  const backend = await openOpfsVolume({
    name: `test-${compteur}`,
    size: TAILLE,
    openHandle: store.openHandle,
    ...reste,
    journal,
  });
  return { backend, journal, store, name: backend.name };
}

function motif(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 31 + graine) % 256);
}

test("la géométrie déclarée est stable, alignée secteur et multiple du bloc v86", async () => {
  const { backend, store } = await volume();

  assert.equal(backend.size(), TAILLE);
  assert.equal(backend.size() % SECTOR_SIZE, 0);
  assert.equal(backend.size() % V86_BLOCK_SIZE, 0, "le contrat de tampon v86 adresse par 256 o");
  assert.equal(backend.describe().kind, "opfs");
  assert.equal(backend.describe().durable, true, "OPFS est un support durable, contrairement à #4");
  assert.equal(backend.describe().sectorSize, SECTOR_SIZE);

  await assert.rejects(
    () => openOpfsVolume({ name: "biscornu", size: 700, openHandle: store.openHandle }),
    RangeError,
  );
  await backend.close();
});

test("le fichier est créé à la géométrie déclarée, pas à la taille des écritures", async () => {
  const { backend, store, name } = await volume();

  assert.equal(store.sizeOf(name), TAILLE, "le volume est alloué à l'ouverture");
  await backend.write(0, motif(SECTOR_SIZE, 1));
  assert.equal(store.sizeOf(name), TAILLE, "une écriture ne redimensionne pas le volume");
  await backend.close();
});

test("lecture à plusieurs offsets, aux limites de blocs et jusqu'à la fin du fichier", async () => {
  const { backend } = await volume();
  const donnees = motif(4 * SECTOR_SIZE, 7);
  await backend.write(TAILLE - 4 * SECTOR_SIZE, donnees);

  const plages = [
    [TAILLE - 4 * SECTOR_SIZE, SECTOR_SIZE],
    [TAILLE - 3 * SECTOR_SIZE - 1, 2],
    [TAILLE - V86_BLOCK_SIZE, V86_BLOCK_SIZE],
    [TAILLE - 1, 1],
    [TAILLE - 4 * SECTOR_SIZE, 4 * SECTOR_SIZE],
  ];

  for (const [offset, longueur] of plages) {
    const relue = await backend.read(offset, longueur);
    const debut = offset - (TAILLE - 4 * SECTOR_SIZE);
    assert.deepEqual(
      [...relue],
      [...donnees.subarray(debut, debut + longueur)],
      `plage ${offset}+${longueur}`,
    );
  }

  // Un octet de plus que la fin du volume est une erreur typée, jamais un tampon complété de zéros.
  await assert.rejects(
    () => backend.read(TAILLE - 1, 2),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.outOfRange),
  );
  await backend.close();
});

test("une écriture non alignée puis une écriture sectorielle se relisent octet pour octet", async () => {
  const { backend } = await volume();
  const nonAlignee = motif(173, 3);
  const sectorielle = motif(SECTOR_SIZE, 11);
  const offsetNonAligne = 5 * SECTOR_SIZE + 37;

  await backend.write(offsetNonAligne, nonAlignee);
  await backend.write(20 * SECTOR_SIZE, sectorielle);

  assert.deepEqual([...(await backend.read(offsetNonAligne, 173))], [...nonAlignee]);
  assert.deepEqual([...(await backend.read(20 * SECTOR_SIZE, SECTOR_SIZE))], [...sectorielle]);

  // Le voisinage immédiat d'une écriture non alignée reste intact : pas de recopie de secteur.
  assert.equal((await backend.read(offsetNonAligne - 1, 1))[0], 0);
  assert.equal((await backend.read(offsetNonAligne + 173, 1))[0], 0);
  await backend.close();
});

test("la lecture rend une copie détachée : modifier le résultat ne touche pas le volume", async () => {
  const { backend } = await volume();
  await backend.write(0, new Uint8Array(SECTOR_SIZE).fill(7));

  const copie = await backend.read(0, SECTOR_SIZE);
  copie[0] = 42;

  assert.equal((await backend.read(0, SECTOR_SIZE))[0], 7);
  await backend.close();
});

test("fermeture puis réouverture : les octets et la géométrie sont identiques", async () => {
  const store = createSyncAccessStore();
  const donnees = motif(3 * SECTOR_SIZE, 5);

  const premier = await openOpfsVolume({
    name: "persistant",
    size: TAILLE,
    openHandle: store.openHandle,
  });
  await premier.write(9 * SECTOR_SIZE + 11, donnees);
  await premier.flush();
  await premier.close();

  // Réouverture SANS taille déclarée : la géométrie est relue du fichier, pas supposée.
  const second = await openOpfsVolume({ name: "persistant", openHandle: store.openHandle });
  assert.equal(second.size(), TAILLE);
  assert.deepEqual([...(await second.read(9 * SECTOR_SIZE + 11, 3 * SECTOR_SIZE))], [...donnees]);
  await second.close();
});

test("réouvrir avec une autre géométrie est une erreur typée, jamais une troncature", async () => {
  const store = createSyncAccessStore();
  const premier = await openOpfsVolume({
    name: "geometrie",
    size: TAILLE,
    openHandle: store.openHandle,
  });
  await premier.close();

  await assert.rejects(
    () => openOpfsVolume({ name: "geometrie", size: TAILLE * 2, openHandle: store.openHandle }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch),
  );
  assert.equal(store.sizeOf("geometrie"), TAILLE, "le volume existant n'a pas été redimensionné");
});

test("une géométrie qui change sous le volume ouvert est détectée, pas absorbée", async () => {
  const { backend, store, name } = await volume();
  await backend.write(0, motif(SECTOR_SIZE, 2));

  // Le support rétrécit à l'insu du backend : c'est exactement ce que `size()` ne doit pas suivre
  // en silence.
  store.resize(name, TAILLE - SECTOR_SIZE);

  assert.equal(backend.size(), TAILLE, "size() reste la géométrie de la session");
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch) &&
      erreur.context.observed === TAILLE - SECTOR_SIZE,
  );
  await assert.rejects(
    () => backend.write(0, motif(SECTOR_SIZE, 2)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch),
  );
});

test("une lecture courte du support devient une erreur typée, jamais un tampon complété", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1, bytes: SECTOR_SIZE },
  ]);
  const { backend } = await volume({ faults });
  await backend.write(0, new Uint8Array(4 * SECTOR_SIZE).fill(0xcd));

  await assert.rejects(
    () => backend.read(0, 4 * SECTOR_SIZE),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.shortRead) &&
      erreur.context.requested === 4 * SECTOR_SIZE &&
      erreur.context.obtained === SECTOR_SIZE,
  );
  await backend.close();
});

test("une écriture partielle du support est signalée et n'entame pas le volume", async () => {
  const { backend } = await volume({ store: { maxWriteBytes: SECTOR_SIZE } });
  const donnees = new Uint8Array(4 * SECTOR_SIZE).fill(0xab);

  await assert.rejects(
    () => backend.write(0, donnees),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.partialWrite) &&
      erreur.context.accepted === SECTOR_SIZE &&
      erreur.context.requested === 4 * SECTOR_SIZE,
  );

  // C'est ici que #16 change le contrat de #6. Jusqu'à cette tranche, une écriture partielle
  // laissait dans le VOLUME les octets acceptés : « ni ancien état complet, ni nouvel état complet »,
  // un état intermédiaire réel et connu — mais un état que l'oracle de #15 classait DÉCHIRÉ. La
  // génération transactionnelle déplace ces octets dans le journal voisin : la déchirure y est aussi
  // réelle, mais elle n'atteint plus le volume, et la génération sera écartée à la réouverture.
  const relue = await backend.read(0, 2 * SECTOR_SIZE);
  assert.equal(relue[0], 0x00, "le volume porte encore l'état d'avant l'écriture");
  assert.equal(relue[SECTOR_SIZE], 0x00);
  await backend.close();
});

test("un dépassement de quota du support est un état distinct, jamais un succès", async () => {
  // Le quota laisse juste de quoi ouvrir le volume et son journal de génération, plus une poignée
  // d'octets : l'écriture qui déborde est celle du JOURNAL, puisque c'est là que va désormais une
  // génération en cours. Le code et le remède ne changent pas — libérer de la place.
  const { backend } = await volume({ store: { quotaBytes: TAILLE + 2048 } });

  let refus = null;
  for (let essai = 0; essai < 8 && refus === null; essai += 1) {
    try {
      await backend.write(essai * SECTOR_SIZE, new Uint8Array(SECTOR_SIZE).fill(essai + 1));
    } catch (erreur) {
      refus = erreur;
    }
  }
  assert.ok(refus !== null, "le quota doit finir par être atteint");
  assert.ok(isStorageError(refus, STORAGE_ERROR_CODES.quotaExceeded), refus?.code);
  assert.equal(refus.context.operation, "write");
});

test("un handle perdu contamine toutes les opérations suivantes", async () => {
  const { backend, store, name } = await volume();
  store.lose(name);

  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("un handle perdu reste un handle perdu, même découvert par la barrière", async () => {
  // La barrière est le seul chemin qui reconstruit son erreur : elle ne doit pas ranger une perte
  // de support dans « échec de barrière ». Les deux états se corrigent différemment — l'un exige
  // de rouvrir le volume, l'autre de réessayer — et les confondre effacerait cette différence.
  const { backend, store, name } = await volume();
  store.lose(name);

  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  // L'état est retenu : l'E/S suivante n'a pas besoin de redécouvrir la panne.
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("un quota atteint pendant la barrière reste un quota, pas un échec de barrière", async () => {
  const { backend, store, name } = await volume();
  // Depuis #16 la barrière scelle le JOURNAL DE GÉNÉRATION voisin : c'est lui que le manque de place
  // frappe désormais. Le remède est le même — libérer de la place —, et le code doit rester distinct
  // d'un échec de barrière.
  store.starve(`${name}.gen`);

  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.quotaExceeded),
  );
});

test("la faute programmée « handle perdu » produit le même état que la perte réelle", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.lostHandle, operation: "write", occurrence: 1 },
  ]);
  const { backend } = await volume({ faults });

  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("une barrière en échec n'est jamais acquittée et laisse une trace ordonnée", async () => {
  const journal = new BlockJournal();
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 1 },
  ]);
  const { backend } = await volume({ journal, faults });

  await backend.write(0, new Uint8Array(SECTOR_SIZE));
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.flushFailed),
  );

  const operations = journal.entries().map((entree) => entree.operation);
  assert.deepEqual(operations, [
    JOURNAL_OPERATIONS.write,
    JOURNAL_OPERATIONS.flush,
    JOURNAL_OPERATIONS.fault,
  ]);
  await backend.close();
});

test("la barrière franchie journalise écriture, barrière puis acquittement, dans cet ordre", async () => {
  const journal = new BlockJournal();
  const { backend, store, name } = await volume({ journal });

  await backend.write(0, new Uint8Array(SECTOR_SIZE).fill(3));
  await backend.flush();

  assert.deepEqual(
    journal.entries().map((entree) => entree.operation),
    [JOURNAL_OPERATIONS.write, JOURNAL_OPERATIONS.flush, JOURNAL_OPERATIONS.flushAck],
  );
  // Trois barrières RÉELLES du support : une à l'ouverture, qui rend durable la racine initiale du
  // journal, puis DEUX par validation (#16, ADR 0014) — la charge d'abord, la racine ensuite.
  // L'ordre est ce qui distingue « validé » de « probablement écrit », et le compte est épinglé pour
  // qu'un raccourci qui n'en franchirait qu'une soit visible.
  assert.equal(store.flushCount(`${name}.gen`), 3, "une à l'ouverture, deux pour la validation");
  assert.equal(store.flushCount(name), 0, "le volume lui-même n'est franchi qu'au point de contrôle");
  await backend.close();
  assert.equal(store.flushCount(name), 1, "la fermeture propre range la génération dans le volume");
});

test("l'ouverture est exclusive et la fermeture transfère la propriété du volume", async () => {
  const store = createSyncAccessStore();
  const premier = await openOpfsVolume({
    name: "exclusif",
    size: TAILLE,
    openHandle: store.openHandle,
  });

  await assert.rejects(
    () => openOpfsVolume({ name: "exclusif", size: TAILLE, openHandle: store.openHandle }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );

  await premier.close();
  const second = await openOpfsVolume({ name: "exclusif", openHandle: store.openHandle });
  assert.equal(second.size(), TAILLE);
  await second.close();
});

test("l'exclusivité refusée par le support lui-même reste une erreur typée", async () => {
  const store = createSyncAccessStore();
  const brut = await store.openHandle("prisonnier");
  brut.truncate(TAILLE);

  await assert.rejects(
    () => openOpfsVolume({ name: "prisonnier", size: TAILLE, openHandle: store.openHandle }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );
  brut.close();
});

test("après fermeture, toute E/S échoue explicitement et le support est relâché", async () => {
  const { backend, store, name } = await volume();
  await backend.close();

  assert.equal(store.isOpen(name), false, "le handle exclusif est rendu au support");
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
});

test("une plage invalide est refusée avant d'atteindre le support", async () => {
  const { backend, store, name } = await volume();
  const avant = store.readCount(name);

  await assert.rejects(() => backend.read(-1, 8), RangeError);
  await assert.rejects(() => backend.read(0, 1.5), RangeError);
  await assert.rejects(() => backend.write(0, "pas un tampon"), TypeError);

  assert.equal(store.readCount(name), avant, "aucun appel au support pour une plage invalide");
  await backend.close();
});
