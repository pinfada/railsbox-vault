// Puits d'écriture SÉQUENTIEL d'une archive (#11) vers un `FileSystemSyncAccessHandle` OPFS.
//
// `writeArchive` n'exige de son puits qu'un `write(bytes)` : il ignore où vont les octets. Ce module
// est l'unique implémentation de ce puits au-dessus d'OPFS, et il existe séparément du banc de
// mesure pour une raison précise (#73) — la lecture de la valeur de retour d'une écriture est le
// point où le dépôt a menti, et un point qui ment doit être testable sans navigateur.
//
// Il tient l'offset courant, refuse toute écriture que le support n'a pas acceptée, et n'avance
// JAMAIS d'octets qu'il n'a pas vus écrits : une archive tronquée ne doit pas se présenter comme
// complète, et un compteur qui avance sur un refus fabriquerait exactement ce mensonge.
//
// La mesure du budget de stockage (#9) est FACULTATIVE et n'est prise qu'en cas d'échec : demander
// `navigator.storage.estimate()` à chaque bloc coûterait une promesse par 4 Mio pour une information
// qui n'intéresse que le diagnostic. Sans mesure, le contexte de l'erreur dit `storage: null` —
// « non mesuré », et non « quota inconnu ».

import { toStorageError, writeCountFailure } from "./opfs-error-mapping.mjs";

/**
 * Crée le puits d'archive.
 *
 * @param {{ write: (bytes: Uint8Array, options: { at: number }) => number, flush?: () => void }} handle
 *   handle OPFS exclusif ouvert sur le fichier d'archive
 * @param {{ volume: string, measureStorage?: () => Promise<object|null> }} options
 *   `volume` nomme le fichier dans les erreurs ; `measureStorage` est appelée UNIQUEMENT sur échec.
 * @returns {{ offset: number, write: (bytes: Uint8Array) => Promise<number>, flush: () => void }}
 */
export function createOpfsArchiveSink(handle, { volume, measureStorage = null }) {
  if (!handle || typeof handle.write !== "function") {
    throw new TypeError("Le puits d'archive attend un handle OPFS exposant write(bytes, { at }).");
  }
  if (typeof volume !== "string" || volume === "") {
    throw new TypeError("Le puits d'archive doit nommer le fichier qu'il écrit.");
  }

  return {
    /** Offset du prochain octet à écrire : il ne compte que des octets réellement acceptés. */
    offset: 0,

    async write(bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Le puits d'archive attend un Uint8Array.");
      }
      const requested = bytes.byteLength;
      const offset = this.offset;

      let returned;
      try {
        returned = handle.write(bytes, { at: offset });
      } catch (cause) {
        // Une exception du support garde sa traduction habituelle : quota, handle perdu, exclusivité.
        throw toStorageError(cause, {
          operation: "write-archive",
          volume,
          offset,
          length: requested,
        });
      }

      const echec = writeCountFailure(returned, {
        requested,
        volume,
        offset,
        operation: "write-archive",
        storage: measureStorage === null ? null : await measureStorage(),
      });
      if (echec !== null) throw echec;

      this.offset = offset + requested;
      return requested;
    },

    /** Barrière de durabilité du support, propagée telle quelle : elle n'est jamais anticipée. */
    flush() {
      if (typeof handle.flush === "function") handle.flush();
    },
  };
}
