import assert from "node:assert/strict";
import test from "node:test";

import {
  BlockJournal,
  JOURNAL_OPERATIONS,
  auditDurabilityBarriers,
} from "../../src/vm/block-journal.mjs";

function horlogeFactice() {
  let valeur = 0;
  return () => (valeur += 10);
}

test("le journal horodate et numérote chaque entrée dans l'ordre d'appel", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.write, { offset: 0, length: 512 });
  journal.record(JOURNAL_OPERATIONS.flush, { barrier: 0 });

  const entrees = journal.entries();
  assert.equal(entrees.length, 2);
  assert.deepEqual(
    entrees.map((entree) => entree.seq),
    [0, 1],
  );
  assert.ok(entrees[1].at > entrees[0].at, "l'horloge doit être monotone");
  assert.equal(entrees[0].operation, "write");
  assert.throws(() => {
    entrees[0].operation = "read";
  }, TypeError);
});

test("une opération inconnue est refusée, y compris si son nom ressemble à une clé", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  assert.throws(() => journal.record("flushAck"), /Opération journalisée inconnue/);
  assert.doesNotThrow(() => journal.record(JOURNAL_OPERATIONS.flushAck, { barrier: 0 }));
});

test("un détail homonyme d'un champ du journal est refusé au lieu de le masquer", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  for (const champ of ["seq", "at", "operation"]) {
    assert.throws(
      () => journal.record(JOURNAL_OPERATIONS.failure, { [champ]: "get" }),
      /masquerait un champ du journal/,
    );
  }
});

test("un journal saturé échoue au lieu d'oublier ses premières entrées", () => {
  const journal = new BlockJournal({ clock: horlogeFactice(), limit: 2 });
  journal.record(JOURNAL_OPERATIONS.read, { offset: 0, length: 512 });
  journal.record(JOURNAL_OPERATIONS.read, { offset: 512, length: 512 });
  assert.throws(() => journal.record(JOURNAL_OPERATIONS.read, {}), /Journal saturé/);
});

test("l'audit de durabilité accepte écriture puis barrière puis acquittement", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.write, { offset: 0, length: 4096 });
  journal.record(JOURNAL_OPERATIONS.flush, { barrier: 0 });
  journal.record(JOURNAL_OPERATIONS.flushAck, { barrier: 0 });

  const audit = auditDurabilityBarriers(journal.entries());
  assert.equal(audit.satisfied, true);
  assert.equal(audit.reason, null);
  assert.equal(audit.barriers.length, 1);
  assert.equal(audit.barriers[0].writesBefore, 1);
  assert.ok(audit.barriers[0].ackSeq > audit.barriers[0].flushSeq);
});

test("une barrière jamais acquittée invalide l'audit", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.write, { offset: 0, length: 4096 });
  journal.record(JOURNAL_OPERATIONS.flush, { barrier: 0 });

  const audit = auditDurabilityBarriers(journal.entries());
  assert.equal(audit.satisfied, false);
  assert.match(audit.reason, /jamais acquittée/);
});

test("une barrière sans écriture préalable invalide l'audit", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.flush, { barrier: 0 });
  journal.record(JOURNAL_OPERATIONS.flushAck, { barrier: 0 });

  const audit = auditDurabilityBarriers(journal.entries());
  assert.equal(audit.satisfied, false);
  assert.match(audit.reason, /sans aucune écriture préalable/);
});

test("l'absence totale de barrière est un échec, pas un silence", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.write, { offset: 0, length: 512 });

  const audit = auditDurabilityBarriers(journal.entries());
  assert.equal(audit.satisfied, false);
  assert.match(audit.reason, /Aucune barrière/);
});

test("un acquittement orphelin est signalé", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.flushAck, { barrier: 7 });

  const audit = auditDurabilityBarriers(journal.entries());
  assert.equal(audit.satisfied, false);
  assert.match(audit.reason, /sans barrière correspondante/);
});

test("les compteurs et le dernier rang par opération sont exacts", () => {
  const journal = new BlockJournal({ clock: horlogeFactice() });
  journal.record(JOURNAL_OPERATIONS.read, { offset: 0, length: 512 });
  journal.record(JOURNAL_OPERATIONS.write, { offset: 0, length: 512 });
  journal.record(JOURNAL_OPERATIONS.read, { offset: 512, length: 512 });

  assert.deepEqual(journal.counts(), { read: 2, write: 1 });
  assert.equal(journal.lastSequenceOf(JOURNAL_OPERATIONS.read), 2);
  assert.equal(journal.lastSequenceOf(JOURNAL_OPERATIONS.flush), -1);
  assert.equal(journal.select(JOURNAL_OPERATIONS.read).length, 2);
});
