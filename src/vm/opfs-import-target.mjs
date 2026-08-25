// Cible OPFS de la restauration (#12, `VAULT-PORT-001`). Elle branche l'orchestration pure de
// `volume-import.mjs` sur le support réel : le backend de blocs de #6 pour le volume, et un FICHIER
// VOISIN pour le manifeste de #10.
//
// Pourquoi un fichier voisin, et non un en-tête dans le volume : la géométrie de #6 est un multiple
// de 512 octets destiné à v86 tel quel — le guest monte ces octets comme un disque. Y intercaler un
// manifeste décalerait le système de fichiers du guest. Le manifeste vit donc à côté, sous le nom du
// volume suivi de `.manifest`, dans le même répertoire OPFS et sous la même validation de frontière.
//
// C'est ce voisin qui porte la VALIDITÉ du volume, et l'ordre des gestes en découle : la
// restauration le retire avant d'écrire le premier octet et ne le réécrit qu'après avoir relu tout
// le volume. Un volume sans son voisin est un volume non identifié — `assertVolumeWritable` (#10) le
// refuse par `VAULT_MANIFEST_UNIDENTIFIED`. Une restauration interrompue ne peut donc pas se faire
// passer pour un volume valide.

import { BlockJournal } from "./block-journal.mjs";
import { openOpfsVolume } from "./opfs-block-backend.mjs";
import { openOpfsSyncAccess, removeOpfsVolume, statOpfsVolume } from "./opfs-sync-access.mjs";
import { manifestSidecarName } from "./volume-import.mjs";

/** Lit intégralement un petit fichier OPFS (un manifeste tient en quelques centaines d'octets). */
async function lireFichier(nom, taille) {
  const handle = await openOpfsSyncAccess(nom);
  try {
    const bytes = new Uint8Array(taille);
    const lus = handle.read(bytes, { at: 0 });
    return lus === taille ? bytes : bytes.subarray(0, lus);
  } finally {
    handle.close();
  }
}

/** Écrit intégralement un petit fichier OPFS, en le remplaçant, et franchit sa barrière. */
async function ecrireFichier(nom, bytes) {
  const handle = await openOpfsSyncAccess(nom);
  try {
    handle.truncate(0);
    const ecrits = handle.write(bytes, { at: 0 });
    if (ecrits !== bytes.byteLength) {
      throw new Error(`Écriture de manifeste courte : ${ecrits}/${bytes.byteLength} octet(s).`);
    }
    handle.flush();
  } finally {
    handle.close();
  }
}

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

    /** Observe la cible SANS la créer : poser une question ne doit pas muter le support. */
    async inspect() {
      const etatVolume = await statOpfsVolume(volume);
      const etatManifeste = await statOpfsVolume(sidecar);
      return {
        present: etatVolume.present,
        size: etatVolume.size,
        manifestBytes:
          etatManifeste.present && etatManifeste.size > 0
            ? await lireFichier(sidecar, etatManifeste.size)
            : null,
      };
    },

    /** Ouvre le volume en exclusivité, à la géométrie de l'archive. */
    open({ size }) {
      return openOpfsVolume({ name: volume, size, journal });
    },

    /** Retire le manifeste : le volume cesse d'être identifié, donc d'être présentable comme valide. */
    async revokeManifest() {
      await removeOpfsVolume(sidecar);
    },

    /** Inscrit le manifeste de l'archive : dernier geste de la restauration. */
    async commitManifest(bytes) {
      await ecrireFichier(sidecar, bytes);
    },
  };
}
