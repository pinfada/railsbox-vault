// Cible OPFS de la MIGRATION (#13, `VAULT-COMPAT-001`). Elle branche l'orchestration pure de
// `volume-migration.mjs` sur le support réel : le backend de blocs de #6 pour le volume, le
// MANIFESTE VOISIN de `opfs-volume-open.mjs` pour son identité, et un second voisin — le JOURNAL DE
// REPRISE — pour ce qu'une migration inachevée doit laisser derrière elle.
//
// Pourquoi un journal voisin plutôt qu'un drapeau dans le manifeste : la migration RÉVOQUE le
// manifeste avant de toucher quoi que ce soit (ADR 0009, geste 4). Une fois révoqué, plus rien ne
// dirait de quel format le volume vient — la reprise serait impossible et il faudrait redemander une
// archive, transformant une interruption en impasse. Le journal porte donc le manifeste SOURCE, la
// chaîne visée et la preuve de sauvegarde retenue.
//
// Les deux voisins vivent dans le même répertoire OPFS que le volume, sous des suffixes RÉSERVÉS par
// la frontière de nommage (`opfs-sync-access.mjs`) : aucun volume ne peut les porter, et la longueur
// maximale d'un nom de volume tient compte du plus long d'entre eux — un volume créable est toujours
// un volume migrable.

import { BlockJournal } from "./block-journal.mjs";
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { openOpfsVolume } from "./opfs-block-backend.mjs";
import {
  manifestSidecarName,
  migrationJournalName,
  removeOpfsVolume,
  statOpfsVolume,
} from "./opfs-sync-access.mjs";
import {
  readSidecarBytes,
  readVolumeManifest,
  revokeVolumeManifest,
  writeSidecarBytes,
} from "./opfs-volume-open.mjs";

/**
 * Construit la cible OPFS attendue par `migrateVolume`.
 *
 * @param {string} volume nom du volume à migrer
 * @param {{ journal?: BlockJournal }} [options] journal du backend, pour publier les compteurs d'E/S
 */
export function createOpfsMigrationTarget(
  volume,
  {
    journal = new BlockJournal(),
    stat = statOpfsVolume,
    readManifest = readVolumeManifest,
    readSidecar = readSidecarBytes,
    revoke = revokeVolumeManifest,
    writeSidecar = writeSidecarBytes,
    removeSidecar = removeOpfsVolume,
    openVolume = openOpfsVolume,
  } = {},
) {
  const manifeste = manifestSidecarName(volume);
  const journalVoisin = migrationJournalName(volume);

  return {
    volume,
    sidecar: manifeste,
    journalSidecar: journalVoisin,
    journal,

    /** Observe le volume SANS le créer : poser une question ne doit rien fabriquer sur le support. */
    inspect() {
      return stat(volume);
    },

    /** Octets du manifeste voisin, ou `null`. Les refus de #10 remontent tels quels. */
    readManifest() {
      return readManifest(volume);
    },

    /**
     * Octets du journal de reprise, ou `null`. Un journal démesuré n'est pas lu : c'est un refus
     * TYPÉ de migration, jamais un journal deviné ni un fichier supprimé pour se faire de la place.
     */
    async readJournal() {
      try {
        return await readSidecar(journalVoisin);
      } catch (cause) {
        if (!(cause instanceof RangeError)) throw cause;
        throw new MigrationError(
          MIGRATION_ERROR_CODES.journalMalformed,
          `Journal de migration illisible : ${cause.message} Il n'est ni supprimé, ni deviné : l'écarter est un geste explicite.`,
          { volume, sidecar: journalVoisin },
        );
      }
    },

    /** Ouvre le volume en exclusivité, à sa géométrie actuelle. Un volume n'est jamais retaillé. */
    open({ size }) {
      return openVolume({ name: volume, size, journal });
    },

    /** Inscrit le journal de reprise. Il précède la révocation, et lui seul rend la reprise possible. */
    async writeJournal(bytes) {
      await writeSidecar(journalVoisin, bytes);
    },

    /** Retire le manifeste : le volume cesse d'être identifié, donc d'être inscriptible. */
    async revokeManifest() {
      await revoke(volume);
    },

    /** Inscrit le manifeste migré : l'avant-dernier geste, et le seul à rendre le volume valide. */
    async commitManifest(bytes) {
      await writeSidecar(manifeste, bytes);
    },

    /** Retire le journal : dernier geste. Sa présence signale toujours une migration inachevée. */
    async removeJournal() {
      await removeSidecar(journalVoisin);
    },
  };
}
