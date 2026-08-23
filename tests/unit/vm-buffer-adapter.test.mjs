import assert from "node:assert/strict";
import test from "node:test";

import { BlockJournal, JOURNAL_OPERATIONS } from "../../src/vm/block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { SECTOR_SIZE, openMemoryVolume } from "../../src/vm/memory-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createV86BufferAdapter } from "../../src/vm/v86-buffer-adapter.mjs";

const TAILLE = 32 * SECTOR_SIZE;
let compteur = 0;

function banc(options = {}) {
  compteur += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `adaptateur-${compteur}`,
    size: TAILLE,
    journal,
    faults: options.faults ?? createFaultPlan(),
    flushDelay: options.flushDelay ?? 0,
  });
  const fatales = [];
  const adapter = createV86BufferAdapter({ backend, onFatal: (erreur) => fatales.push(erreur) });
  return { adapter, backend, journal, fatales };
}

test("l'adaptateur refuse d'exister sans destinataire d'erreur", () => {
  const backend = openMemoryVolume({ name: "sans-destinataire", size: TAILLE });
  assert.throws(() => createV86BufferAdapter({ backend }), TypeError);
  return backend.close();
});

test("l'adaptateur expose la géométrie et acquitte le chargement attendu par v86", () => {
  const { adapter } = banc();
  assert.equal(adapter.byteLength, TAILLE);

  let charge = false;
  adapter.onload = () => {
    charge = true;
  };
  adapter.load();
  assert.equal(charge, true);
});

test("set copie la tranche : v86 réutilise son tampon interne dès l'appel suivant", async () => {
  const { adapter, backend } = banc();
  const tamponInterne = new Uint8Array(SECTOR_SIZE).fill(0x11);

  const ecrit = new Promise((resolve) => adapter.set(0, tamponInterne.subarray(0), resolve));
  // v86 écrase son tampon sans attendre l'acquittement : sans copie, le volume recevrait 0x22.
  tamponInterne.fill(0x22);
  await ecrit;

  const relue = backend.snapshot(0, SECTOR_SIZE);
  assert.equal(relue[0], 0x11);
});

test("get rend exactement les octets demandés", async () => {
  const { adapter, backend } = banc();
  await backend.write(0, new Uint8Array(SECTOR_SIZE).fill(0x5a));

  const donnees = await new Promise((resolve) => adapter.get(0, SECTOR_SIZE, resolve));
  assert.equal(donnees.byteLength, SECTOR_SIZE);
  assert.equal(donnees[0], 0x5a);
});

test("une lecture en échec n'acquitte JAMAIS l'opération vers v86", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1, bytes: 0 },
  ]);
  const { adapter, fatales, journal } = banc({ faults });

  let acquitte = false;
  adapter.get(0, SECTOR_SIZE, () => {
    acquitte = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(acquitte, false, "un tampon de zéros serait une donnée valide pour le guest");
  assert.equal(fatales.length, 1);
  assert.ok(isStorageError(fatales[0], STORAGE_ERROR_CODES.shortRead));
  assert.equal(journal.counts()[JOURNAL_OPERATIONS.failure], 1);
});

test("une écriture partielle remonte au runtime sans acquitter le périphérique", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.partialWrite, operation: "write", occurrence: 1, bytes: SECTOR_SIZE },
  ]);
  const { adapter, fatales } = banc({ faults });

  let acquitte = false;
  adapter.set(0, new Uint8Array(4 * SECTOR_SIZE).fill(1), () => {
    acquitte = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(acquitte, false);
  assert.ok(isStorageError(fatales[0], STORAGE_ERROR_CODES.partialWrite));
});

test("flush n'acquitte qu'après la barrière, et prévient son appelant en cas d'échec", async () => {
  const { adapter, backend, journal } = banc({ flushDelay: 5 });
  await backend.write(0, new Uint8Array(SECTOR_SIZE));

  await new Promise((resolve) => adapter.flush(resolve));
  const operations = journal.entries().map((entree) => entree.operation);
  assert.deepEqual(operations.slice(-2), [JOURNAL_OPERATIONS.flush, JOURNAL_OPERATIONS.flushAck]);

  const echec = createFaultPlan([
    { kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 1 },
  ]);
  const second = banc({ faults: echec });
  await second.backend.write(0, new Uint8Array(SECTOR_SIZE));

  const erreur = await new Promise((resolve) =>
    second.adapter.flush(
      () => resolve(new Error("la barrière n'aurait pas dû être acquittée")),
      resolve,
    ),
  );
  assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.flushFailed));
  assert.equal(second.fatales.length, 1);
});

test("les capacités absentes sont refusées, jamais simulées", () => {
  const { adapter } = banc();
  for (const methode of ["get_buffer", "get_state", "set_state"]) {
    assert.throws(
      () => adapter[methode](),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.unsupported),
      `${methode} doit échouer explicitement`,
    );
  }
});

test("le signal d'annulation de v86 est journalisé sans priver v86 de son acquittement", async () => {
  const { adapter, journal } = banc();
  const controleur = new AbortController();
  controleur.abort();

  await new Promise((resolve) =>
    adapter.get(0, SECTOR_SIZE, resolve, { signal: controleur.signal }),
  );
  const marques = journal.select(JOURNAL_OPERATIONS.mark).map((entree) => entree.label);
  assert.ok(marques.includes("get-aborted"));
});
