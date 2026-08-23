import assert from "node:assert/strict";
import test from "node:test";

import { BlockJournal, JOURNAL_OPERATIONS } from "../../src/vm/block-journal.mjs";
import { ATA, BRIDGE_MODES, installDurabilityBridge } from "../../src/vm/v86-flush-bridge.mjs";

// Double de `IDEInterface` reproduisant ce que le pont touche : le dispatch de commandes ATA, le
// paquet IDENTIFY, les registres d'état et l'interruption. Les vraies instances de v86 sont
// scellées, ce qui est justement la raison pour laquelle le pont opère sur le PROTOTYPE.
class FakeIdeInterface {
  constructor(buffer, { atapi = false } = {}) {
    this.buffer = buffer;
    this.is_atapi = atapi;
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

function banc({ flushImplementation } = {}) {
  const journal = new BlockJournal();
  const adapter = {
    flushCalls: 0,
    flush(onAck, onError) {
      this.flushCalls += 1;
      (flushImplementation ?? ((ack) => ack()))(onAck, onError);
    },
  };
  const master = new FakeIdeInterface(adapter);
  const cdrom = new FakeIdeInterface({}, { atapi: true });
  const ideController = { primary: { master }, secondary: { master: cdrom } };
  return { journal, adapter, master, cdrom, ideController };
}

function motIdentify(data, mot) {
  return data[mot * 2] | (data[mot * 2 + 1] << 8);
}

test("le pont arme les bits de cache d'écriture du paquet IDENTIFY", () => {
  const { journal, adapter, master, ideController } = banc();
  const pont = installDurabilityBridge({ ideController, adapter, journal });

  master.create_identify_packet();
  for (const mot of ATA.identifyWriteCacheWords) {
    assert.equal(
      (motIdentify(master.data, mot) >> ATA.identifyWriteCacheBit) & 1,
      1,
      `le mot ${mot} doit annoncer le cache d'écriture`,
    );
  }
  pont.uninstall();
});

test("mode identify : le guest reçoit le cache d'écriture, le backend ne reçoit rien", () => {
  const { journal, adapter, master, ideController } = banc();
  const pont = installDurabilityBridge({
    ideController,
    adapter,
    journal,
    mode: BRIDGE_MODES.identify,
  });

  master.create_identify_packet();
  assert.equal((motIdentify(master.data, 82) >> ATA.identifyWriteCacheBit) & 1, 1);

  master.ata_command(ATA.cmdFlushCache);
  assert.equal(adapter.flushCalls, 0, "la barrière doit rester chez v86 dans ce mode");
  assert.deepEqual(master.handled, [ATA.cmdFlushCache]);
  pont.uninstall();
});

test("un mode inconnu est refusé au lieu d'être interprété", () => {
  const { journal, adapter, ideController } = banc();
  assert.throws(
    () => installDurabilityBridge({ ideController, adapter, journal, mode: "presque" }),
    /Mode de pont inconnu/,
  );
});

test("mode observe : IDENTIFY reste celui d'amont et FLUSH CACHE n'atteint pas le backend", () => {
  const { journal, adapter, master, ideController } = banc();
  const pont = installDurabilityBridge({
    ideController,
    adapter,
    journal,
    mode: BRIDGE_MODES.observe,
  });

  master.create_identify_packet();
  assert.equal(motIdentify(master.data, 82), 0);

  master.ata_command(ATA.cmdFlushCache);
  assert.equal(adapter.flushCalls, 0);
  assert.deepEqual(master.handled, [ATA.cmdFlushCache]);
  // Le témoin négatif journalise quand même la commande : c'est ainsi qu'on prouve que le guest
  // n'en émet AUCUNE dans les conditions amont.
  assert.equal(journal.counts()[JOURNAL_OPERATIONS.ata], 1);
  pont.uninstall();
});

test("FLUSH CACHE passe par le backend et n'acquitte le guest qu'après la barrière", () => {
  let acquittement = null;
  const { journal, adapter, master, ideController } = banc({
    flushImplementation: (onAck) => {
      acquittement = onAck;
    },
  });
  const pont = installDurabilityBridge({ ideController, adapter, journal });

  master.ata_command(ATA.cmdFlushCache);
  assert.equal(adapter.flushCalls, 1);
  assert.equal(master.status_reg, ATA.srBsy, "le guest doit rester en attente");
  assert.equal(master.irqs, 0);
  assert.deepEqual(master.handled, [], "la commande amont ne doit pas être exécutée en plus");

  acquittement();
  assert.equal(master.status_reg, ATA.srDrdy | ATA.srDsc);
  assert.equal(master.irqs, 1);
  pont.uninstall();
});

test("FLUSH CACHE EXT emprunte le même chemin", () => {
  const { journal, adapter, master, ideController } = banc();
  const pont = installDurabilityBridge({ ideController, adapter, journal });

  master.ata_command(ATA.cmdFlushCacheExt);
  assert.equal(adapter.flushCalls, 1);
  pont.uninstall();
});

test("une barrière en échec abandonne la commande au lieu de laisser le guest attendre", () => {
  const { journal, adapter, master, ideController } = banc({
    flushImplementation: (_onAck, onError) => onError(new Error("support perdu")),
  });
  const pont = installDurabilityBridge({ ideController, adapter, journal });

  master.ata_command(ATA.cmdFlushCache);
  assert.equal(master.error_reg, ATA.erAbrt);
  assert.equal(master.status_reg, ATA.srDrdy | ATA.srErr);
  assert.equal(master.irqs, 1);
  pont.uninstall();
});

test("les autres commandes et les autres disques gardent le comportement amont", () => {
  const { journal, adapter, master, cdrom, ideController } = banc();
  const pont = installDurabilityBridge({ ideController, adapter, journal });

  master.ata_command(0xec);
  assert.deepEqual(master.handled, [0xec]);
  assert.equal(adapter.flushCalls, 0);

  cdrom.ata_command(ATA.cmdFlushCache);
  assert.deepEqual(cdrom.handled, [ATA.cmdFlushCache]);
  assert.equal(adapter.flushCalls, 0);
  assert.equal(journal.counts()[JOURNAL_OPERATIONS.ata], 1, "seul le disque Vault est journalisé");
  pont.uninstall();
});

test("le retrait du pont restitue exactement les méthodes d'origine", () => {
  const { journal, adapter, master, ideController } = banc();
  const prototype = Object.getPrototypeOf(master);
  const avant = { ata: prototype.ata_command, identify: prototype.create_identify_packet };

  const pont = installDurabilityBridge({ ideController, adapter, journal });
  assert.notEqual(prototype.ata_command, avant.ata);
  assert.throws(
    () => installDurabilityBridge({ ideController, adapter, journal }),
    /déjà installé/,
  );

  pont.uninstall();
  assert.equal(prototype.ata_command, avant.ata);
  assert.equal(prototype.create_identify_packet, avant.identify);
});

test("un contrôleur sans disque maître est refusé au lieu d'être ignoré", () => {
  const journal = new BlockJournal();
  assert.throws(
    () => installDurabilityBridge({ ideController: {}, adapter: {}, journal }),
    /primary\.master/,
  );
});
