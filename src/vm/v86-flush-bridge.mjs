// Pont de durabilité entre le guest et le backend Vault.
//
// Deux ruptures mesurées sur v86 0.5.432 (amont `847e34d`) empêchent une barrière de durabilité
// d'atteindre le stockage, et il faut les traiter TOUTES LES DEUX :
//
//  1. `create_identify_packet` n'arme pas le bit « write cache » (mot 82 bit 5, mot 85 bit 5). Le
//     noyau du guest voit un disque en écriture immédiate, classe `sda` en `write through` et
//     n'émet JAMAIS de FLUSH CACHE, pas même sur `sync` ou `fsync`.
//  2. `ata_command` traite FLUSH CACHE (0xE7) et FLUSH CACHE EXT (0xEA) en posant `DRDY|DSC` et en
//     levant l'interruption, sans jamais appeler le tampon disque.
//
// Le pont corrige les deux à l'exécution, sur le PROTOTYPE de `IDEInterface` — les instances sont
// scellées par v86. Il ne touche que les interfaces dont le tampon est l'adaptateur fourni : le
// CD-ROM et tout autre disque conservent le comportement amont.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";

export const ATA = Object.freeze({
  cmdFlushCache: 0xe7,
  cmdFlushCacheExt: 0xea,
  srErr: 0x01,
  srDsc: 0x10,
  srDrdy: 0x40,
  srBsy: 0x80,
  erAbrt: 0x04,
  /** Mot 82 bit 5 : « write cache supporté ». Mot 85 bit 5 : « write cache activé ». */
  identifyWriteCacheWords: Object.freeze([82, 85]),
  identifyWriteCacheBit: 5,
});

const INSTALLED = Symbol.for("railsbox-vault.v86-durability-bridge");

function setIdentifyBit(data, word, bit) {
  // Le paquet IDENTIFY est une suite de 256 mots de 16 bits en petit-boutiste.
  const byte = word * 2 + (bit >= 8 ? 1 : 0);
  data[byte] |= 1 << (bit % 8);
}

/**
 * Modes du pont. Les trois sont mesurés par le spike #4, et il en faut trois : les deux ruptures
 * sont en série, et seul le mode intermédiaire montre la seconde à l'œuvre.
 */
export const BRIDGE_MODES = Object.freeze({
  /** Comportement amont exact ; seules les commandes ATA sont journalisées. */
  observe: "observe",
  /** IDENTIFY corrigé, FLUSH CACHE laissé à v86 : le guest demande, le backend ne reçoit rien. */
  identify: "identify",
  /** Les deux corrections : la barrière du guest atteint le backend. */
  full: "full",
});

const KNOWN_MODES = new Set(Object.values(BRIDGE_MODES));

/**
 * Installe l'observation des commandes ATA et, selon le mode, le pont de durabilité.
 *
 * À appeler AVANT `emulator.run()` : le noyau lit le paquet IDENTIFY une seule fois au démarrage,
 * et un pont posé après coup n'obtiendrait de barrières qu'après un `rescan` explicite du guest.
 *
 * @param {{ ideController: object, adapter: object, mode?: string,
 *           journal: import("./block-journal.mjs").BlockJournal }} options
 * @returns {{ uninstall: () => void }}
 */
export function installDurabilityBridge({
  ideController,
  adapter,
  journal,
  mode = BRIDGE_MODES.full,
}) {
  if (!KNOWN_MODES.has(mode)) {
    throw new Error(
      `Mode de pont inconnu : ${mode}. Valeurs admises : ${[...KNOWN_MODES].join(", ")}.`,
    );
  }
  const announcesWriteCache = mode !== BRIDGE_MODES.observe;
  const forwardsBarrier = mode === BRIDGE_MODES.full;
  const master = ideController?.primary?.master;
  if (!master) {
    throw new Error("Contrôleur IDE inattendu : `primary.master` est absent.");
  }
  const prototype = Object.getPrototypeOf(master);
  if (prototype[INSTALLED]) {
    throw new Error("Le pont de durabilité est déjà installé sur ce prototype IDEInterface.");
  }

  const originalAtaCommand = prototype.ata_command;
  const originalIdentify = prototype.create_identify_packet;
  const targets = (self) => self.buffer === adapter;

  prototype.create_identify_packet = function patchedIdentify() {
    originalIdentify.call(this);
    if (!announcesWriteCache || !targets(this) || this.is_atapi) return;
    for (const word of ATA.identifyWriteCacheWords) {
      setIdentifyBit(this.data, word, ATA.identifyWriteCacheBit);
    }
    journal.record(JOURNAL_OPERATIONS.mark, { label: "identify-write-cache" });
  };

  prototype.ata_command = function patchedAtaCommand(command) {
    if (!targets(this)) return originalAtaCommand.call(this, command);

    journal.record(JOURNAL_OPERATIONS.ata, { command });

    if (!forwardsBarrier || (command !== ATA.cmdFlushCache && command !== ATA.cmdFlushCacheExt)) {
      return originalAtaCommand.call(this, command);
    }

    // Le guest doit attendre : occupé tant que la barrière n'a pas abouti.
    this.status_reg = ATA.srBsy;
    const iface = this;
    adapter.flush(
      () => {
        iface.status_reg = ATA.srDrdy | ATA.srDsc;
        iface.push_irq();
      },
      () => {
        // Abandon explicite : le guest verra une erreur d'E/S, pas un délai de garde muet.
        iface.error_reg = ATA.erAbrt;
        iface.status_reg = ATA.srDrdy | ATA.srErr;
        iface.push_irq();
      },
    );
    return undefined;
  };

  prototype[INSTALLED] = true;

  return {
    uninstall() {
      prototype.ata_command = originalAtaCommand;
      prototype.create_identify_packet = originalIdentify;
      delete prototype[INSTALLED];
    },
  };
}
