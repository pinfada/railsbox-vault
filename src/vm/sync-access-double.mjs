// Double déterministe de `FileSystemSyncAccessHandle`, pour éprouver le backend OPFS sous Node.
//
// Il existe pour une raison précise : le vrai OPFS ne produit pas de quota, de handle perdu ni
// d'écriture partielle à la demande. Sans double, ces états contractuels ne seraient jamais
// exercés, ou le seraient par un `throw` posé dans le backend lui-même — c'est-à-dire par le code
// que le test prétend vérifier.
//
// Ce double n'est PAS une preuve que le vrai OPFS se comporte ainsi. Il est un instrument, et un
// instrument se calibre : `tests/unit/vm-sync-access-double.test.mjs` vérifie qu'il respecte les
// sémantiques de la spécification, et `tests/browser/opfs-block-backend.spec.mjs` rejoue la même
// sonde de persistance sur le vrai support, dans un Worker Chromium. Les deux doivent rendre la
// même empreinte de volume.
//
// Sémantiques reproduites (WHATWG File System, `FileSystemSyncAccessHandle`) :
//  - `read(buffer, { at })` rend le nombre d'octets lus, 0 au-delà de la fin, sans jamais compléter ;
//  - `write(buffer, { at })` rend le nombre d'octets écrits et étend le fichier si nécessaire ;
//  - `truncate(size)` étend avec des zéros ou coupe ;
//  - un second handle sur le même fichier lève `NoModificationAllowedError` ;
//  - toute méthode après `close()` lève `InvalidStateError` ;
//  - un dépassement de quota lève `QuotaExceededError`.

const GROWTH_PADDING = 4096;

function domException(name, message) {
  return new DOMException(message, name);
}

/** Copie de croissance : le stockage réel n'a pas de `Uint8Array` extensible. */
function grow(bytes, minimumLength) {
  if (bytes.byteLength >= minimumLength) return bytes;
  const grown = new Uint8Array(minimumLength + GROWTH_PADDING);
  grown.set(bytes);
  return grown;
}

/**
 * Crée un espace de stockage isolé qui distribue des handles.
 *
 * @param {{ quotaBytes?: number, maxWriteBytes?: number, writeCostBytes?: number }} [options]
 *   `quotaBytes` borne le total des volumes ; `maxWriteBytes` plafonne UN appel `write` pour
 *   produire une écriture partielle ; `writeCostBytes` ajoute un coût forfaitaire par écriture,
 *   ce qui permet d'épuiser le quota sans faire grandir le volume.
 */
export function createSyncAccessStore({
  quotaBytes = Number.POSITIVE_INFINITY,
  maxWriteBytes = Number.POSITIVE_INFINITY,
  writeCostBytes = 0,
} = {}) {
  /** @type {Map<string, { bytes: Uint8Array, size: number, lost: boolean, flushes: number, reads: number }>} */
  const files = new Map();
  const open = new Set();

  const fileOf = (name) => {
    let file = files.get(name);
    if (!file) {
      file = {
        bytes: new Uint8Array(0),
        size: 0,
        lost: false,
        starved: false,
        flushes: 0,
        reads: 0,
      };
      files.set(name, file);
    }
    return file;
  };

  const usedBytes = () => [...files.values()].reduce((total, file) => total + file.size, 0);

  const assertQuota = (extraBytes) => {
    if (usedBytes() + extraBytes > quotaBytes) {
      throw domException(
        "QuotaExceededError",
        `Quota de ${quotaBytes} octet(s) dépassé de ${usedBytes() + extraBytes - quotaBytes}.`,
      );
    }
  };

  function makeHandle(name) {
    const file = fileOf(name);
    let closed = false;

    const assertLive = () => {
      if (closed) domExceptionThrow("Handle fermé.");
      if (file.lost) domExceptionThrow("Le fichier a disparu sous le handle.");
    };
    const domExceptionThrow = (message) => {
      throw domException("InvalidStateError", message);
    };

    return {
      getSize() {
        assertLive();
        return file.size;
      },
      read(buffer, { at = 0 } = {}) {
        assertLive();
        file.reads += 1;
        const available = Math.max(0, file.size - at);
        const count = Math.min(buffer.byteLength, available);
        const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        target.set(file.bytes.subarray(at, at + count));
        return count;
      },
      write(buffer, { at = 0 } = {}) {
        assertLive();
        const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const count = Math.min(source.byteLength, maxWriteBytes);
        const end = at + count;
        assertQuota(Math.max(0, end - file.size) + writeCostBytes);
        file.bytes = grow(file.bytes, end);
        file.bytes.set(source.subarray(0, count), at);
        file.size = Math.max(file.size, end);
        return count;
      },
      truncate(newSize) {
        assertLive();
        assertQuota(Math.max(0, newSize - file.size));
        file.bytes = grow(file.bytes, newSize);
        if (newSize < file.size) file.bytes.fill(0, newSize, file.size);
        file.size = newSize;
      },
      flush() {
        assertLive();
        // Un vrai `flush()` écrit : il peut donc buter sur le quota comme une écriture.
        if (file.starved) {
          throw domException("QuotaExceededError", "Plus de place pour matérialiser la barrière.");
        }
        file.flushes += 1;
      },
      close() {
        closed = true;
        open.delete(name);
      },
    };
  }

  return Object.freeze({
    /** Ouvre le handle exclusif. Signature et erreurs de `createSyncAccessHandle`. */
    async openHandle(name) {
      if (open.has(name)) {
        throw domException(
          "NoModificationAllowedError",
          `Le fichier « ${name} » est déjà ouvert en accès synchrone.`,
        );
      }
      open.add(name);
      return makeHandle(name);
    },
    /** Le fichier disparaît sous les handles ouverts, sans fermeture propre. */
    lose(name) {
      fileOf(name).lost = true;
    },
    /** Le support n'a plus de place : la prochaine barrière du fichier échoue sur le quota. */
    starve(name) {
      fileOf(name).starved = true;
    },
    /** Le support redimensionne le fichier à l'insu du volume ouvert. */
    resize(name, newSize) {
      const file = fileOf(name);
      file.bytes = grow(file.bytes, newSize);
      if (newSize < file.size) file.bytes.fill(0, newSize, file.size);
      file.size = newSize;
    },
    isOpen: (name) => open.has(name),
    sizeOf: (name) => fileOf(name).size,
    flushCount: (name) => fileOf(name).flushes,
    readCount: (name) => fileOf(name).reads,
    usedBytes,
    /** Copie du contenu, pour comparer un volume sans passer par le backend. */
    snapshot(name) {
      const file = fileOf(name);
      return file.bytes.slice(0, file.size);
    },
  });
}
