// Adaptateur entre le contrat de stockage de Vault (`read`/`write`/`flush`/`size`, promesses,
// erreurs typées) et le contrat de tampon disque de v86 (`get`/`set`/`load`, callbacks, aucun canal
// d'erreur). L'écart le plus lourd est celui-là : `get(start, len, fn)` et `set(start, data, fn)`
// n'offrent AUCUN moyen de signaler un échec au périphérique IDE.
//
// Le repli « rendre des zéros » ou « appeler le callback quand même » est interdit par
// `docs/architecture.md` : il transformerait une erreur de support en donnée valide pour le guest.
// L'adaptateur choisit donc l'arrêt explicite : il n'acquitte pas l'opération, marque le volume en
// panne et remonte l'erreur typée à l'appelant, à charge pour lui d'arrêter la VM.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/**
 * Toute défaillance du support devient une `StorageError` avant d'entrer dans le journal ou dans
 * `onFatal`. La couture est ici, au niveau du module, parce qu'elle ne dépend d'aucun état de
 * l'adaptateur : elle ne fait que refuser qu'une erreur nue traverse la frontière du contrat.
 *
 * @param {unknown} error
 * @returns {StorageError}
 */
function typerEchecDeSupport(error) {
  return error instanceof StorageError
    ? error
    : new StorageError(
        STORAGE_ERROR_CODES.handleLost,
        `Échec non typé du support : ${error?.message ?? error}`,
        {},
      );
}

/**
 * @param {{ backend: import("./memory-block-backend.mjs").MemoryBlockBackend,
 *           onFatal: (error: StorageError) => void }} options
 */
export function createV86BufferAdapter({ backend, onFatal }) {
  if (typeof onFatal !== "function") {
    throw new TypeError(
      "L'adaptateur exige un gestionnaire onFatal : une erreur de support ne peut pas rester sans destinataire.",
    );
  }

  const journal = backend.journal;
  let fatal = null;
  let inFlight = 0;

  // Retient la PREMIÈRE erreur, journalise, puis prévient le runtime — dans cet ordre : `onFatal`
  // peut arrêter la VM, et le journal doit déjà porter la trace quand il le fait.
  const fail = (error, context) => {
    const typed = typerEchecDeSupport(error);
    if (fatal === null) fatal = typed;
    journal.record(JOURNAL_OPERATIONS.failure, {
      code: typed.code,
      message: typed.message,
      ...context,
    });
    onFatal(typed);
  };

  // Le contrat est RENDU directement : l'adaptateur n'a jamais eu besoin de se nommer lui-même, et
  // le rendre tel quel laisse voir qu'au-delà des quelques gestes ci-dessus, cette fabrique ne fait
  // que déclarer les neuf membres attendus par `ide.js`.
  return {
    /** Géométrie lue une seule fois par `ide.js` à la construction. */
    byteLength: backend.size(),
    onload: undefined,
    onprogress: undefined,

    /** v86 attend `onload` même quand rien n'est à charger. */
    load() {
      if (typeof this.onload === "function") this.onload({});
    },

    /**
     * @param {number} start
     * @param {number} length
     * @param {(data: Uint8Array) => void} fn
     * @param {{ signal?: AbortSignal }} [options]
     */
    get(start, length, fn, options) {
      inFlight += 1;
      backend
        .read(start, length)
        .then((data) => {
          // v86 annule ses E/S en vol lors d'un reset. Le callback reste appelé : c'est `ide.js`
          // qui filtre, et ne pas l'appeler laisserait fuir son identifiant d'opération.
          if (options?.signal?.aborted) {
            journal.record(JOURNAL_OPERATIONS.mark, {
              label: "get-aborted",
              offset: start,
              length,
            });
          }
          fn(data);
        })
        .catch((error) => fail(error, { source: "get", offset: start, length }))
        .finally(() => {
          inFlight -= 1;
        });
    },

    /**
     * @param {number} start
     * @param {Uint8Array} slice
     * @param {() => void} fn
     */
    set(start, slice, fn) {
      // COPIE OBLIGATOIRE : sur le chemin PIO, `ide.js` passe une vue de son tampon interne
      // (`this.data.subarray(...)`) qu'il réutilise dès l'instruction suivante. Un backend
      // asynchrone qui garderait la vue écrirait des octets déjà remplacés.
      const owned = slice.slice();
      inFlight += 1;
      backend
        .write(start, owned)
        .then(() => fn())
        .catch((error) => fail(error, { source: "set", offset: start, length: owned.byteLength }))
        .finally(() => {
          inFlight -= 1;
        });
    },

    /**
     * Barrière de durabilité. Absente du contrat de tampon amont : c'est le pont installé par
     * `v86-flush-bridge.mjs` qui l'appelle, sur réception d'un ATA FLUSH CACHE.
     * @param {() => void} fn acquittement, appelé seulement si la barrière a abouti
     * @param {(error: StorageError) => void} [onError] permet au pont d'abandonner la commande ATA
     *   au lieu de laisser le guest attendre son délai de garde. L'échec reste aussi fatal côté
     *   runtime : le guest apprend « erreur d'E/S », l'exploitant apprend laquelle.
     */
    flush(fn, onError) {
      inFlight += 1;
      backend
        .flush()
        .then(() => fn())
        .catch((error) => {
          fail(error, { source: "flush" });
          if (typeof onError === "function") onError(error);
        })
        .finally(() => {
          inFlight -= 1;
        });
    },

    /** Snapshot mémoire : hors périmètre du spike #4, refusé explicitement. */
    get_buffer() {
      throw new StorageError(
        STORAGE_ERROR_CODES.unsupported,
        "get_buffer n'est pas fourni : un volume Vault ne se recopie pas en un ArrayBuffer unique.",
      );
    },

    get_state() {
      throw new StorageError(
        STORAGE_ERROR_CODES.unsupported,
        "get_state n'est pas fourni : les instantanés de VM sont hors périmètre tant qu'ils ne sont pas liés à une génération du volume.",
      );
    },

    set_state() {
      throw new StorageError(
        STORAGE_ERROR_CODES.unsupported,
        "set_state n'est pas fourni : restaurer un instantané sur un volume mutable est écarté par docs/architecture.md.",
      );
    },

    /** État observable par le runtime, jamais par le guest. */
    status() {
      return { fatal, inFlight };
    },
  };
}
