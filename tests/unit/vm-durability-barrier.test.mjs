import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import {
  BlockJournal,
  JOURNAL_OPERATIONS,
  auditDurabilityBarriers,
} from "../../src/vm/block-journal.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { generationJournalName } from "../../src/vm/opfs-sync-access.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { ATA, installDurabilityBridge } from "../../src/vm/v86-flush-bridge.mjs";
import { createV86BufferAdapter } from "../../src/vm/v86-buffer-adapter.mjs";

// Preuve unitaire de la barrière durable de bout en bout (#14, `SEC-DURABLE-001`,
// `VAULT-PERSIST-001`). Elle assemble la CHAÎNE COMPLÈTE moins l'émulateur : le pont ATA
// (`v86-flush-bridge`), l'adaptateur de tampon (`v86-buffer-adapter`), le backend OPFS
// (`opfs-block-backend`) et le double déterministe de `FileSystemSyncAccessHandle`
// (`sync-access-double`). Le niveau navigateur — `tests/vm/opfs-barrier.spec.mjs` — rejoue le même
// enchaînement avec un vrai guest Linux et le vrai OPFS ; ici, le double donne le contrôle
// DÉTERMINISTE de l'ordre, de la latence et des fautes que le vrai support refuse de produire.
//
// Ce que #6 avait établi : la barrière atteint le support. Ce que #14 doit établir : AUCUNE écriture
// n'est annoncée durable au guest avant que le flush OPFS ait réellement rendu la main. La nuance
// est exactement le témoin de la barrière retardée ci-dessous.

const TAILLE = 64 * SECTOR_SIZE;
let compteur = 0;

function motif(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 31 + graine) % 256);
}

/**
 * Double de `IDEInterface` réduit à ce que le pont touche : le dispatch de commandes ATA, le paquet
 * IDENTIFY, les registres d'état et l'interruption. Le pont opère sur le PROTOTYPE, comme sur les
 * instances scellées de v86 ; une sous-classe fraîche par banc garantit un prototype par test.
 */
class FakeIdeInterface {
  constructor(buffer) {
    this.buffer = buffer;
    this.is_atapi = false;
    this.data = new Uint8Array(512);
    this.status_reg = 0;
    this.error_reg = 0;
    this.irqs = 0;
    this.handled = [];
  }

  ata_command(command) {
    this.handled.push(command);
    this.status_reg = ATA.srDrdy | ATA.srDsc;
    this.push_irq();
  }

  create_identify_packet() {
    this.data.fill(0);
  }

  push_irq() {
    this.irqs += 1;
  }
}

/** Laisse la file de microtâches ET de macrotâches se vider : l'adaptateur acquitte en `.then`. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Écriture PIO du guest : `set` copie le tampon et rappelle son callback au succès. */
function ecrire(adapter, offset, bytes) {
  return new Promise((resolve) => adapter.set(offset, bytes, resolve));
}

/**
 * Assemble la chaîne complète au-dessus d'un double neuf, sous un nom jamais réutilisé.
 * @returns {Promise<object>} le banc, à refermer par `fermer`.
 */
async function banc({ flushDelay = 0, seuilPointDeControle } = {}) {
  compteur += 1;
  const name = `barriere-${compteur}`;
  const store = createSyncAccessStore();
  const journal = new BlockJournal();
  const backend = await openOpfsVolume({
    name,
    size: TAILLE,
    journal,
    flushDelay,
    openHandle: store.openHandle,
    seuilPointDeControle,
  });
  const failures = [];
  // Depuis #16 (ADR 0014), la barrière ne franchit plus le fichier du VOLUME : elle scelle la
  // génération dans le journal voisin. C'est donc CE fichier que le témoin de barrière retardée doit
  // bloquer, et c'est sur lui que se comptent les flush réels du support. La propriété éprouvée par
  // ce banc — aucun acquittement avant que le support ait rendu la main — est inchangée ; seul le
  // fichier que le support matérialise a changé, et le dire ici évite qu'un témoin devenu inerte
  // passe pour un témoin vert.
  const nomJournal = generationJournalName(name);
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error),
  });
  // Sous-classe fraîche : le pont patche `Object.getPrototypeOf(master)`, propre à ce banc.
  class Instance extends FakeIdeInterface {}
  const master = new Instance(adapter);
  const bridge = installDurabilityBridge({
    ideController: { primary: { master } },
    adapter,
    journal,
  });
  return { name, nomJournal, store, journal, backend, adapter, failures, master, bridge };
}

async function fermer({ bridge, backend }) {
  bridge.uninstall();
  await backend.close();
}

/** Numéros de séquence du journal, par opération. */
function seqs(journal, operation) {
  return journal.select(operation).map((entree) => entree.seq);
}

test("l'ordre écriture → flush → acquittement traverse le backend OPFS réel", async () => {
  const banc0 = await banc();
  const { journal, store, name, nomJournal, adapter, master, failures } = banc0;
  try {
    await ecrire(adapter, 0, motif(SECTOR_SIZE, 1));
    await ecrire(adapter, 2 * SECTOR_SIZE, motif(SECTOR_SIZE, 2));

    master.ata_command(ATA.cmdFlushCache);
    await tick();

    const [flushSeq] = seqs(journal, JOURNAL_OPERATIONS.flush);
    const [ackSeq] = seqs(journal, JOURNAL_OPERATIONS.flushAck);
    const writes = seqs(journal, JOURNAL_OPERATIONS.write);
    assert.equal(writes.length, 2);
    assert.ok(Math.max(...writes) < flushSeq, "toute écriture précède la barrière dans le journal");
    assert.ok(flushSeq < ackSeq, "l'acquittement suit la barrière");
    // DEUX flush réels du support pour la validation : la charge, puis la racine qui la scelle.
    // L'ouverture d'un journal vierge n'en franchit aucune — elle n'écrit rien.
    assert.equal(store.flushCount(nomJournal), 2, "l'acquittement suit des flush RÉELS du support");
    assert.equal(store.flushCount(name), 0, "le volume n'est franchi qu'au point de contrôle");
    assert.equal(master.status_reg, ATA.srDrdy | ATA.srDsc, "le guest est acquitté");
    assert.equal(master.irqs, 1);
    assert.deepEqual(failures, [], "aucune erreur de support n'a été absorbée");

    const audit = auditDurabilityBarriers(journal.entries());
    assert.equal(audit.satisfied, true, audit.reason ?? "");

    // La trace corrèle commande guest (ATA), appel backend (flush) et résultat (flush-ack) SANS
    // aucune donnée utilisateur : aucune entrée du journal ne porte d'octets.
    for (const entree of journal.entries()) {
      for (const valeur of Object.values(entree)) {
        assert.ok(
          !ArrayBuffer.isView(valeur) && !(valeur instanceof ArrayBuffer),
          `l'entrée « ${entree.operation} » ne doit porter aucun octet`,
        );
      }
    }
  } finally {
    await fermer(banc0);
  }
});

test("aucune barrière n'est acquittée au guest avant que le flush OPFS ait rendu la main", async () => {
  const banc0 = await banc();
  const { journal, store, nomJournal, adapter, master } = banc0;
  try {
    await ecrire(adapter, 0, motif(SECTOR_SIZE, 3));

    // La barrière est RETARDÉE : `flush()` du support reste en vol jusqu'à `releaseFlush`. Elle est
    // posée sur le JOURNAL DE GÉNÉRATION, seul fichier que la barrière franchit depuis #16.
    store.blockFlush(nomJournal);
    master.ata_command(ATA.cmdFlushCache);
    await tick();

    // Le flush OPFS n'a pas rendu la main. Le guest DOIT rester occupé, et rien ne doit être
    // annoncé durable : ni acquittement, ni flush-ack, ni flush réel du support.
    assert.equal(
      master.status_reg,
      ATA.srBsy,
      "le guest reste BSY tant que le flush n'a pas abouti",
    );
    assert.equal(master.irqs, 0, "aucun acquittement anticipé");
    // Aucun flush n'a encore eu lieu : la barrière du guest est en vol, et l'ouverture d'un journal
    // vierge n'en franchit aucune.
    assert.equal(store.flushCount(nomJournal), 0, "le support n'a pas matérialisé cette barrière");
    assert.equal(
      journal.counts()[JOURNAL_OPERATIONS.flushAck] ?? 0,
      0,
      "aucun flush-ack avant le flush réel",
    );
    assert.ok(store.isFlushPending(nomJournal), "la barrière est bien en vol");

    // Le flush OPFS rend enfin la main : l'acquittement peut alors, et seulement alors, remonter.
    store.releaseFlush(nomJournal);
    await tick();

    assert.equal(store.flushCount(nomJournal), 2, "les deux flush de la validation ont eu lieu");
    assert.equal(master.status_reg, ATA.srDrdy | ATA.srDsc, "le guest est acquitté APRÈS le flush");
    assert.equal(master.irqs, 1);
    assert.equal(journal.counts()[JOURNAL_OPERATIONS.flushAck], 1);
  } finally {
    await fermer(banc0);
  }
});

test("deux flush consécutifs sans écriture intermédiaire restent sûrs et mesurables", async () => {
  const banc0 = await banc();
  const { journal, store, nomJournal, adapter, master, failures } = banc0;
  try {
    await ecrire(adapter, 0, motif(SECTOR_SIZE, 5));

    master.ata_command(ATA.cmdFlushCache);
    await tick();
    assert.equal(master.irqs, 1, "première barrière acquittée");

    // Aucune écriture entre les deux barrières : la seconde doit tout de même aboutir proprement.
    master.ata_command(ATA.cmdFlushCache);
    await tick();
    assert.equal(master.irqs, 2, "seconde barrière acquittée");

    // Deux pour la première validation, puis UNE pour la barrière à vide : rien n'a été déposé entre
    // les deux, il n'y a donc pas de racine à réécrire — mais le support est TOUT DE MÊME sollicité,
    // faute de quoi un support devenu incapable d'écrire resterait invisible.
    assert.equal(store.flushCount(nomJournal), 3, "trois flush réels du support");
    assert.equal(journal.counts()[JOURNAL_OPERATIONS.flush], 2);
    assert.equal(journal.counts()[JOURNAL_OPERATIONS.flushAck], 2);
    assert.deepEqual(failures, []);
    assert.equal(master.status_reg, ATA.srDrdy | ATA.srDsc, "pas d'erreur sur une barrière à vide");
  } finally {
    await fermer(banc0);
  }
});

test("un échec du support PENDANT la barrière remonte au guest et à la coquille, sans état durable inventé", async () => {
  const banc0 = await banc();
  const { journal, store, nomJournal, adapter, master, failures } = banc0;
  try {
    await ecrire(adapter, 0, motif(SECTOR_SIZE, 7));

    store.blockFlush(nomJournal);
    master.ata_command(ATA.cmdFlushCache);
    await tick();
    assert.equal(master.status_reg, ATA.srBsy, "le guest attend la barrière");

    // Le support disparaît PENDANT l'écriture de la barrière : la barrière échoue.
    store.releaseFlush(nomJournal, { fail: "InvalidStateError" });
    await tick();

    // Le guest observe une erreur d'E/S (registre ABRT), pas un délai de garde muet…
    assert.equal(master.error_reg, ATA.erAbrt, "le guest reçoit une erreur d'E/S");
    assert.equal(master.status_reg, ATA.srDrdy | ATA.srErr);
    // …la coquille observe une erreur TYPÉE…
    assert.equal(failures.length, 1, "la coquille est prévenue une fois");
    assert.equal(failures[0].code, "VAULT_STORAGE_HANDLE_LOST");
    // …et AUCUN état durable n'est inventé : ni flush-ack, ni flush réel du support.
    assert.equal(
      journal.counts()[JOURNAL_OPERATIONS.flushAck] ?? 0,
      0,
      "une barrière en échec n'est jamais acquittée",
    );
    assert.equal(store.flushCount(nomJournal), 0, "aucune barrière n'a été matérialisée");
  } finally {
    await fermer(banc0);
  }
});

test("une barrière refusée immédiatement par le support est typée et jamais acquittée", async () => {
  const banc0 = await banc();
  const { journal, store, nomJournal, adapter, master, failures } = banc0;
  try {
    await ecrire(adapter, 0, motif(SECTOR_SIZE, 9));

    // Quota épuisé : le support refuse la barrière sans délai (pas de barrière retardée). C'est le
    // JOURNAL DE GÉNÉRATION qui manque de place, puisque c'est lui que la barrière franchit.
    store.starve(nomJournal);
    master.ata_command(ATA.cmdFlushCache);
    await tick();

    assert.equal(master.error_reg, ATA.erAbrt, "le guest reçoit une erreur d'E/S");
    assert.equal(master.status_reg, ATA.srDrdy | ATA.srErr);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "VAULT_STORAGE_QUOTA_EXCEEDED", "un quota reste un quota");
    assert.equal(
      journal.counts()[JOURNAL_OPERATIONS.flushAck] ?? 0,
      0,
      "un refus de barrière n'est jamais acquitté",
    );
  } finally {
    await fermer(banc0);
  }
});

test("le RANGEMENT d'une génération ne retient pas la commande ATA du guest", async () => {
  // Défaut MEDIUM-1 de la revue de #90. Le point de contrôle — relecture, réécriture de plusieurs
  // mébioctets, barrière du volume — s'exécutait DANS la promesse de `flush()`, donc avant que le
  // pont ne lève BSY et n'émette l'IRQ. « Jamais sur le chemin de l'acquittement » était vrai de la
  // DURABILITÉ, faux de la commande ATA : le guest restait bloqué pendant tout le rangement.
  //
  // Le banc abaisse le seuil de rangement à un seul secteur, pour qu'un rangement ait lieu à chaque
  // barrière, et retarde la barrière du VOLUME — celle que seul le rangement franchit. Le guest doit
  // être acquitté malgré ce rangement encore en vol.
  const banc0 = await banc({ seuilPointDeControle: SECTOR_SIZE });
  const { journal, store, name, nomJournal, adapter, master, backend } = banc0;
  try {
    await ecrire(adapter, 0, motif(SECTOR_SIZE, 11));

    // La barrière du VOLUME reste en vol : le rangement ne peut pas finir.
    store.blockFlush(name);
    master.ata_command(ATA.cmdFlushCache);
    await tick();

    // Le guest est acquitté — la génération est validée, le journal l'a scellée — alors que le
    // rangement, lui, attend toujours le support.
    assert.equal(master.status_reg, ATA.srDrdy | ATA.srDsc, "le guest n'attend pas le rangement");
    assert.equal(master.irqs, 1);
    assert.equal(journal.counts()[JOURNAL_OPERATIONS.flushAck], 1);
    assert.equal(store.flushCount(nomJournal), 2, "la validation, elle, a bien eu lieu");
    assert.ok(store.isFlushPending(name), "le rangement attend encore la barrière du volume");

    // Le rangement aboutit ensuite, sans rien devoir au guest.
    store.releaseFlush(name);
    await backend.flush();
    assert.equal(backend.dernierRangement, null, "le rangement a fini sans échec");
    assert.ok(backend.dureeRangementMaxMs >= 0, "sa durée est publiée");
  } finally {
    await fermer(banc0);
  }
});
