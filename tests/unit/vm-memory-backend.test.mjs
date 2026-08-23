import assert from "node:assert/strict";
import test from "node:test";

import { BlockJournal, JOURNAL_OPERATIONS } from "../../src/vm/block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { SECTOR_SIZE, openMemoryVolume } from "../../src/vm/memory-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";

const TAILLE = 64 * SECTOR_SIZE;
let compteur = 0;

function volume(options = {}) {
  compteur += 1;
  const journal = options.journal ?? new BlockJournal();
  const backend = openMemoryVolume({
    name: `test-${compteur}`,
    size: TAILLE,
    journal,
    ...options,
  });
  return { backend, journal };
}

test("la géométrie est stable et refuse une taille non alignée sur le secteur", () => {
  const { backend } = volume();
  assert.equal(backend.size(), TAILLE);
  assert.equal(backend.describe().durable, false);
  assert.throws(() => openMemoryVolume({ name: "biscornu", size: 700 }), RangeError);
});

test("une écriture puis une lecture rendent exactement les mêmes octets", async () => {
  const { backend } = volume();
  const donnees = Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => index % 256);

  await backend.write(SECTOR_SIZE, donnees);
  const relues = await backend.read(SECTOR_SIZE, SECTOR_SIZE);

  assert.deepEqual([...relues], [...donnees]);
});

test("la lecture rend une copie détachée du support", async () => {
  const { backend } = volume();
  await backend.write(0, new Uint8Array(SECTOR_SIZE).fill(7));
  const copie = await backend.read(0, SECTOR_SIZE);
  copie[0] = 42;

  const relue = await backend.read(0, SECTOR_SIZE);
  assert.equal(relue[0], 7, "modifier la copie ne doit pas modifier le volume");
});

test("un accès hors bornes est une erreur typée", async () => {
  const { backend } = volume();
  await assert.rejects(
    () => backend.read(TAILLE - 16, 32),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.outOfRange),
  );
  await assert.rejects(
    () => backend.write(TAILLE, new Uint8Array(1)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.outOfRange),
  );
});

test("une lecture courte du support devient une erreur, jamais un tampon tronqué", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1, bytes: SECTOR_SIZE },
  ]);
  const { backend } = volume({ faults });

  await assert.rejects(
    () => backend.read(0, 4 * SECTOR_SIZE),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.shortRead) &&
      erreur.context.requested === 4 * SECTOR_SIZE &&
      erreur.context.obtained === SECTOR_SIZE,
  );
});

test("une écriture partielle est signalée, et les octets acceptés restent écrits", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.partialWrite, operation: "write", occurrence: 1, bytes: SECTOR_SIZE },
  ]);
  const { backend } = volume({ faults });
  const donnees = new Uint8Array(4 * SECTOR_SIZE).fill(0xab);

  await assert.rejects(
    () => backend.write(0, donnees),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.partialWrite),
  );

  // Ni ancien état complet, ni nouvel état complet : l'état intermédiaire est réel et connu.
  const relue = await backend.read(0, 2 * SECTOR_SIZE);
  assert.equal(relue[0], 0xab);
  assert.equal(relue[SECTOR_SIZE], 0x00);
});

test("un échec de barrière est distinct d'un succès et laisse une trace", async () => {
  const journal = new BlockJournal();
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 1 },
  ]);
  const { backend } = volume({ journal, faults });

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
  assert.ok(
    !operations.includes(JOURNAL_OPERATIONS.flushAck),
    "une barrière en échec ne doit jamais être acquittée",
  );
});

test("un handle perdu contamine toutes les opérations suivantes", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.lostHandle, operation: "write", occurrence: 1 },
  ]);
  const { backend } = volume({ faults });

  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("l'ouverture est exclusive tant que le volume n'est pas fermé", async () => {
  const backend = openMemoryVolume({ name: "exclusif", size: TAILLE });
  assert.throws(
    () => openMemoryVolume({ name: "exclusif", size: TAILLE }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );

  await backend.close();
  const second = openMemoryVolume({ name: "exclusif", size: TAILLE });
  assert.equal(second.size(), TAILLE);
  await second.close();
});

test("après fermeture, toute E/S échoue explicitement", async () => {
  const { backend } = volume();
  await backend.close();

  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
});

test("la barrière est acquittée après son délai, dans l'ordre journalisé", async () => {
  const journal = new BlockJournal();
  const { backend } = volume({ journal, flushDelay: 5 });

  await backend.write(0, new Uint8Array(SECTOR_SIZE));
  await backend.flush();

  const operations = journal.entries().map((entree) => entree.operation);
  assert.deepEqual(operations, [
    JOURNAL_OPERATIONS.write,
    JOURNAL_OPERATIONS.flush,
    JOURNAL_OPERATIONS.flushAck,
  ]);
});
