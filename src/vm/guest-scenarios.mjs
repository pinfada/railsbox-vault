// Scénarios de guest partagés par le harnais Node du spike et par la preuve navigateur. Les deux
// mesurent la même chose sur les mêmes commandes ; un écart entre eux serait un résultat, pas un
// détail de plomberie.

import { JOURNAL_OPERATIONS, auditDurabilityBarriers } from "./block-journal.mjs";

/**
 * Scénario court, celui de la preuve `intégration VM` : écrire, franchir la barrière, vérifier
 * l'ordre. Il n'exige ni système de fichiers ni formatage, donc il ne dépend d'aucun utilitaire
 * du guest au-delà de `dd` et de `cat`.
 */
export const BARRIER_STEPS = Object.freeze([
  {
    label: "cache-type",
    command: "cat /sys/block/sda/device/scsi_disk/*/cache_type",
  },
  {
    label: "write-then-flush",
    command: "dd if=/dev/zero of=/dev/sda bs=4096 count=4 conv=fsync 2>&1",
  },
]);

/**
 * Protocole complet du spike : formatage ext2, montage, écriture d'un fichier, `sync`, démontage
 * puis remontage. Il mesure les granularités réelles d'un système de fichiers, pas seulement
 * celles de `dd`.
 */
export const FILESYSTEM_STEPS = Object.freeze([
  { label: "cache-type", command: "cat /sys/block/sda/device/scsi_disk/*/cache_type" },
  {
    label: "write-raw",
    command: "dd if=/dev/urandom of=/dev/sda bs=4096 count=4 conv=notrunc 2>&1",
  },
  {
    label: "write-fsync",
    command: "dd if=/dev/urandom of=/dev/sda bs=4096 count=4 seek=64 conv=fsync 2>&1",
  },
  { label: "mkfs", command: "mke2fs -q -F /dev/sda 2>&1; echo rc=$?" },
  { label: "mount", command: "mkdir -p /mnt2; mount -t ext2 /dev/sda /mnt2 && echo monte" },
  { label: "file-sync", command: "echo bonjour-vault > /mnt2/temoin.txt; sync; echo fait" },
  { label: "umount", command: "umount /mnt2; echo rc=$?" },
  {
    label: "remount",
    command: "mount -t ext2 /dev/sda /mnt2 && cat /mnt2/temoin.txt; umount /mnt2",
  },
]);

/**
 * Marques ASCII de la preuve de persistance OPFS (#6). Deux directions sont mesurées :
 * l'hôte écrit `HOST_MARKER` dans le volume AVANT le boot et le guest doit le relire ; le guest
 * écrit `GUEST_MARKER` puis `sync`, et l'hôte doit le retrouver dans le fichier OPFS après avoir
 * fermé puis rouvert le handle.
 *
 * Elles sont en ASCII imprimable pour traverser la console série sans encodage, et leurs secteurs
 * sont éloignés des structures que le noyau examine à l'amorçage.
 */
export const HOST_MARKER = "VAULT-HOTE-OPFS-0123456789ABCDEF";
export const GUEST_MARKER = "VAULT-GUEST-OPFS-0123456789ABCD";
export const HOST_MARKER_OFFSET = 2048 * 512;
export const GUEST_MARKER_OFFSET = 4096 * 512;

/**
 * Étapes de la preuve de persistance OPFS. Deux précautions les rendent lisibles :
 *
 *  - `dd bs=1` adresse à l'OCTET : la mesure porte sur des octets exacts, pas sur un secteur
 *    arrondi, ce qui exerce le chemin non aligné du backend depuis le guest lui-même ;
 *  - chaque lecture est suivie d'un `echo` : `dd` n'émet pas de fin de ligne, et la marque se
 *    confondrait avec le jeton de fin de commande de la console série.
 *
 * Ces commandes n'ont plus à tenir sous 80 colonnes : `src/vm/serial-console.mjs` recolle les
 * lignes que le terminal du guest replie à cette largeur (#54), écho comme sortie.
 *
 * `conv=fsync` est indispensable : le spike #4 a mesuré que `sync` seul ne fait pas émettre de
 * FLUSH CACHE au guest sur ce noyau. Sans lui, la barrière ne traverserait jamais le backend.
 */
export const OPFS_PERSISTENCE_STEPS = Object.freeze([
  { label: "cache-type", command: "cat /sys/block/sda/device/scsi_disk/*/cache_type" },
  {
    label: "lire-marque-hote",
    command: `dd if=/dev/sda bs=1 skip=${HOST_MARKER_OFFSET} count=${HOST_MARKER.length} 2>/dev/null; echo`,
  },
  { label: "preparer-marque", command: `printf ${GUEST_MARKER} > /tmp/m; echo rc=$?` },
  {
    label: "ecrire-marque-guest",
    command: `dd if=/tmp/m of=/dev/sda bs=1 seek=${GUEST_MARKER_OFFSET} conv=fsync 2>/dev/null`,
  },
  {
    label: "relire-marque-guest",
    command: `dd if=/dev/sda bs=1 skip=${GUEST_MARKER_OFFSET} count=${GUEST_MARKER.length} 2>/dev/null; echo`,
  },
]);

/** Exécute une liste d'étapes sur une session ouverte. */
export async function runSteps(session, steps) {
  const results = [];
  for (const step of steps) {
    results.push(await session.shell(step.command, { label: step.label }));
  }
  return results;
}

/** Résumé par étape : commandes ATA, granularités observées, barrières franchies. */
export function summariseSteps(journal, results) {
  const entries = journal.entries();
  return results.map((result) => {
    const slice = entries.slice(result.from, result.to);
    const commands = {};
    for (const entry of slice) {
      if (entry.operation !== JOURNAL_OPERATIONS.ata) continue;
      const key = `0x${entry.command.toString(16).toUpperCase()}`;
      commands[key] = (commands[key] ?? 0) + 1;
    }
    const lengths = (operation) => [
      ...new Set(
        slice.filter((entry) => entry.operation === operation).map((entry) => entry.length),
      ),
    ];
    return {
      label: result.label,
      output: result.output,
      ata: commands,
      reads: slice.filter((entry) => entry.operation === JOURNAL_OPERATIONS.read).length,
      readLengths: lengths(JOURNAL_OPERATIONS.read).sort((a, b) => a - b),
      writes: slice.filter((entry) => entry.operation === JOURNAL_OPERATIONS.write).length,
      writeLengths: lengths(JOURNAL_OPERATIONS.write).sort((a, b) => a - b),
      flushes: slice.filter((entry) => entry.operation === JOURNAL_OPERATIONS.flush).length,
      flushAcks: slice.filter((entry) => entry.operation === JOURNAL_OPERATIONS.flushAck).length,
    };
  });
}

/**
 * Verdict de la preuve `intégration VM` : le guest a-t-il obtenu une barrière de durabilité qui
 * traverse réellement le backend, dans l'ordre écriture → barrière → acquittement ?
 */
export function verdictForBarrierScenario(journal) {
  const audit = auditDurabilityBarriers(journal.entries());
  const counts = journal.counts();
  return {
    satisfied: audit.satisfied,
    reason: audit.reason,
    barriers: audit.barriers,
    counts,
  };
}
