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
 * Traduit le mode en les DEUX drapeaux que les correctifs consomment, et refuse un mode inconnu.
 *
 * Extrait du pont parce que c'est la seule décision qu'il prend sur des données pures : la lire
 * séparément fait voir que les deux ruptures d'amont se corrigent indépendamment, et que seul
 * `full` les corrige toutes les deux.
 *
 * @param {string} mode une valeur de `BRIDGE_MODES`
 * @returns {{ announcesWriteCache: boolean, forwardsBarrier: boolean }}
 */
function interpreterMode(mode) {
  if (!KNOWN_MODES.has(mode)) {
    throw new Error(
      `Mode de pont inconnu : ${mode}. Valeurs admises : ${[...KNOWN_MODES].join(", ")}.`,
    );
  }
  return {
    announcesWriteCache: mode !== BRIDGE_MODES.observe,
    forwardsBarrier: mode === BRIDGE_MODES.full,
  };
}

/**
 * Fabrique le remplaçant de `create_identify_packet` : la PREMIÈRE des deux ruptures d'amont.
 *
 * Sortie du pont pour que celui-ci ne garde que la validation et la pose. Le remplaçant reste une
 * `function` nommée, jamais une flèche : v86 l'appelle comme méthode d'`IDEInterface`, et c'est ce
 * `this` qui porte `data`, `is_atapi` et `buffer`.
 *
 * @param {Function} originalIdentify l'implémentation amont, toujours appelée en premier
 * @param {{ announcesWriteCache: boolean, targets: (self: object) => boolean,
 *           journal: import("./block-journal.mjs").BlockJournal }} couture
 */
function correctifIdentify(originalIdentify, { announcesWriteCache, targets, journal }) {
  return function patchedIdentify() {
    originalIdentify.call(this);
    if (!announcesWriteCache || !targets(this) || this.is_atapi) return;
    for (const word of ATA.identifyWriteCacheWords) {
      setIdentifyBit(this.data, word, ATA.identifyWriteCacheBit);
    }
    journal.record(JOURNAL_OPERATIONS.mark, { label: "identify-write-cache" });
  };
}

/**
 * Fabrique le remplaçant d'`ata_command` : la SECONDE rupture, celle qui acquitte FLUSH CACHE sans
 * jamais toucher le tampon disque.
 *
 * L'ordre des gestes de la barrière est le contrat `SEC-DURABLE-001` et ne se réordonne pas : lever
 * BSY AVANT d'appeler `adapter.flush`, puis n'acquitter — statut rendu, `push_irq()` — que dans les
 * rappels, une fois la barrière aboutie ou abandonnée.
 *
 * @param {Function} originalAtaCommand l'implémentation amont, seule voie pour tout autre cas
 * @param {{ forwardsBarrier: boolean, targets: (self: object) => boolean, adapter: object,
 *           journal: import("./block-journal.mjs").BlockJournal }} couture
 */
function correctifAtaCommand(originalAtaCommand, { forwardsBarrier, targets, adapter, journal }) {
  return function patchedAtaCommand(command) {
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
}

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
  // Le mode est validé AVANT toute inspection du contrôleur : un mode inconnu est une faute d'appel,
  // et elle doit se voir même sur un contrôleur lui-même inattendu.
  const { announcesWriteCache, forwardsBarrier } = interpreterMode(mode);
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

  // Les deux correctifs sont posés dans cet ordre-là, mais aucun n'est actif avant `emulator.run()` :
  // seule la pose du drapeau ci-dessous rend l'installation observable pour une seconde tentative.
  prototype.create_identify_packet = correctifIdentify(originalIdentify, {
    announcesWriteCache,
    targets,
    journal,
  });
  prototype.ata_command = correctifAtaCommand(originalAtaCommand, {
    forwardsBarrier,
    targets,
    adapter,
    journal,
  });

  prototype[INSTALLED] = true;

  return {
    uninstall() {
      prototype.ata_command = originalAtaCommand;
      prototype.create_identify_packet = originalIdentify;
      delete prototype[INSTALLED];
    },
  };
}
