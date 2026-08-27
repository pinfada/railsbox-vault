// Cible OPFS de la restauration (#12, `VAULT-PORT-001`). Elle branche l'orchestration pure de
// `volume-import.mjs` sur le support réel : le backend de blocs de #6 pour le volume, et le
// MANIFESTE VOISIN de `opfs-volume-open.mjs` pour son identité.
//
// Pourquoi un fichier voisin, et non un en-tête dans le volume : la géométrie de #6 est un multiple
// de 512 octets destiné à v86 tel quel — le guest monte ces octets comme un disque. Y intercaler un
// manifeste décalerait le système de fichiers du guest. Le manifeste vit donc à côté, sous le nom du
// volume suivi du suffixe réservé, dans le même répertoire OPFS et sous la même validation de
// frontière.
//
// C'est ce voisin qui porte la VALIDITÉ du volume, et l'ordre des gestes en découle : la
// restauration le retire une fois la cible ouverte et avant le premier octet écrit, puis ne le
// réécrit qu'après avoir relu tout le volume. Un volume sans son voisin est un volume non
// identifié — `openVolumeForWrite` refuse alors de l'ouvrir en écriture, par
// `VAULT_MANIFEST_UNIDENTIFIED` (#10). Une restauration interrompue ne peut donc pas se faire passer
// pour un volume valide.

import { BlockJournal } from "./block-journal.mjs";
import { openOpfsVolume } from "./opfs-block-backend.mjs";
import { isManifestError } from "./manifest-errors.mjs";
import {
  generationJournalName,
  manifestSidecarName,
  migrationJournalName,
  removeOpfsVolume,
  statOpfsVolume,
} from "./opfs-sync-access.mjs";
import {
  readVolumeManifest,
  revokeVolumeManifest,
  writeSidecarBytes,
} from "./opfs-volume-open.mjs";

/**
 * Octets rendus pour un voisin PRÉSENT mais illisible — trop grand pour être lu sous le budget de
 * surmémoire, ou inaccessible. Ce n'est ni `null` (« pas de voisin »), ni un manifeste :
 * `importArchive` le refusera par `parseManifest` et s'arrêtera SANS rien détruire. L'échec devient
 * un fait observé, il ne disparaît pas.
 */
const VOISIN_ILLISIBLE = new TextEncoder().encode("vault:voisin-illisible");

/**
 * Construit la cible OPFS attendue par `importArchive`.
 *
 * @param {string} volume nom du volume à restaurer
 * @param {{ journal?: BlockJournal }} [options] journal du backend, pour publier les compteurs d'E/S
 */
export function createOpfsImportTarget(
  volume,
  {
    journal = new BlockJournal(),
    stat = statOpfsVolume,
    readManifest = readVolumeManifest,
    revoke = revokeVolumeManifest,
    writeManifest = writeSidecarBytes,
    removeSidecar = removeOpfsVolume,
    openVolume = openOpfsVolume,
  } = {},
) {
  const sidecar = manifestSidecarName(volume);

  return {
    volume,
    sidecar,
    journal,

    /** Observe la cible SANS la créer : poser une question ne doit rien fabriquer sur le support. */
    async inspect() {
      const etatVolume = await stat(volume);
      let manifestBytes;
      try {
        manifestBytes = await readManifest(volume);
      } catch (cause) {
        // SEULE une erreur de FORMAT devient un fait observé. Un voisin au-delà du plafond de
        // lecture n'est pas un manifeste : le dire à l'orchestration la fait refuser sans rien
        // détruire. Un échec de SUPPORT — volume occupé, handle perdu, OPFS absent — est autre
        // chose, et le convertir ferait remonter « cible non vide » là où l'exploitant doit lire
        // « volume occupé ». Le refus resterait sûr, mais il nommerait la mauvaise cause, donc
        // enverrait vers le mauvais remède. Il est propagé tel quel.
        if (!isManifestError(cause)) throw cause;
        manifestBytes = VOISIN_ILLISIBLE;
      }
      return { present: etatVolume.present, size: etatVolume.size, manifestBytes };
    },

    /**
     * Ouvre le volume en exclusivité, à la géométrie de l'archive, et SANS génération
     * transactionnelle (#16, ADR 0014).
     *
     * Une restauration réécrit le volume ENTIER, d'un bloc à l'autre, avec une seule barrière à la
     * fin. Ce n'est pas une génération du guest : la restauration porte déjà son propre protocole
     * d'atomicité — manifeste révoqué avant la première mutation, volume relu depuis le support,
     * manifeste inscrit en dernier (ADR 0009) —, et une restauration interrompue laisse un volume
     * NON IDENTIFIÉ que le boot refuse. Empiler le journal de génération par-dessus doublerait les
     * écritures d'une archive de plusieurs centaines de mébioctets et buterait sur le plafond de
     * charge, sans rien garantir de plus.
     *
     * OUVRIR NE MUTE RIEN, et surtout pas le journal de génération. Une version antérieure de cette
     * tranche le retirait ici, avant même d'acquérir le handle : une ouverture qui échouait pour une
     * raison étrangère à la restauration — un second onglet détenant le volume (#8), un handle
     * perdu, un quota — rendait alors un refus PROPRE, manifeste jamais révoqué, volume en apparence
     * intact… alors que la dernière barrière ACQUITTÉE du guest venait d'être effacée, hors de tout
     * code `VAULT_STORAGE_GENERATION_*`. Le journal est retiré par `discardGeneration`, au premier
     * geste mutant.
     */
    open({ size }) {
      return openVolume({ name: volume, size, journal, transactionnel: false });
    },

    /** Retire le manifeste : le volume cesse d'être identifié, donc d'être inscriptible. */
    async revokeManifest() {
      await revoke(volume);
    },

    /**
     * Retire le journal de génération du volume ÉCRASÉ. Appelé APRÈS `revokeManifest`, jamais avant.
     *
     * Le laisser ferait rejouer, au premier boot suivant, une génération du volume d'AVANT par-dessus
     * le volume restauré — une corruption silencieuse d'un volume pourtant relu et vérifié. Le
     * retirer trop tôt effacerait une écriture acquittée d'un volume que la restauration n'a pas
     * encore touché. L'ordre — révoquer, puis écarter — fait qu'une coupure entre les deux laisse un
     * volume NON IDENTIFIÉ, que le boot refuse : le seul état sûr des deux.
     */
    async discardGeneration() {
      return removeSidecar(generationJournalName(volume));
    },

    /**
     * Inscrit le manifeste de l'archive : dernier geste de la restauration. Le JOURNAL DE MIGRATION
     * éventuel est retiré au passage (#13) : le volume vient d'être réécrit intégralement depuis
     * l'archive, si bien qu'un journal laissé par une migration interrompue ne décrit plus aucun
     * octet présent. Le garder le ferait FAIRE AUTORITÉ sur le format de départ à la prochaine
     * migration, et rendrait le volume restauré non migrable jusqu'à un nettoyage manuel.
     */
    async commitManifest(bytes) {
      await writeManifest(sidecar, bytes);
      await removeSidecar(migrationJournalName(volume));
    },
  };
}
