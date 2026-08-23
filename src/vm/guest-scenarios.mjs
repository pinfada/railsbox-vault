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
