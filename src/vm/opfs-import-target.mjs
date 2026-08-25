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
import { manifestSidecarName, statOpfsVolume } from "./opfs-sync-access.mjs";
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
export function createOpfsImportTarget(volume, { journal = new BlockJournal() } = {}) {
  const sidecar = manifestSidecarName(volume);

  return {
    volume,
    sidecar,
    journal,

    /** Observe la cible SANS la créer : poser une question ne doit rien fabriquer sur le support. */
    async inspect() {
      const etatVolume = await statOpfsVolume(volume);
      let manifestBytes;
      try {
        manifestBytes = await readVolumeManifest(volume);
      } catch {
        manifestBytes = VOISIN_ILLISIBLE;
      }
      return { present: etatVolume.present, size: etatVolume.size, manifestBytes };
    },

    /** Ouvre le volume en exclusivité, à la géométrie de l'archive. */
    open({ size }) {
      return openOpfsVolume({ name: volume, size, journal });
    },

    /** Retire le manifeste : le volume cesse d'être identifié, donc d'être inscriptible. */
    async revokeManifest() {
      await revokeVolumeManifest(volume);
    },

    /** Inscrit le manifeste de l'archive : dernier geste de la restauration. */
    async commitManifest(bytes) {
      await writeSidecarBytes(sidecar, bytes);
    },
  };
}
