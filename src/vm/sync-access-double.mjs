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
 * Enregistrement neuf d'un fichier du double : ses octets, son état contractuel, ses compteurs.
 *
 * Séparé de `fileOf` (#93) parce que ce sont deux choses : la FORME d'un fichier — dont la moitié
 * des champs n'existe que pour armer un état que le vrai OPFS ne produit pas à la demande — et le
 * rite de mémoïsation qui l'entoure. Les lire d'un bloc chacune vaut mieux que les lire imbriquées.
 */
function creerEnregistrement() {
  return {
    bytes: new Uint8Array(0),
    size: 0,
    lost: false,
    starved: false,
    gateArmed: false,
    gate: null,
    flushes: 0,
    reads: 0,
    // Handles distribués et encore vivants. `abandon` doit pouvoir les invalider SANS passer
    // par leur `close()`, qui est une fermeture propre — voir plus bas.
    vivants: new Set(),
  };
}

/**
 * Fabrique le handle exclusif d'un fichier : la surface de `FileSystemSyncAccessHandle`.
 *
 * Sorti du corps de `createSyncAccessStore` (#93) : le magasin déclare qui distribue les handles et
 * qui tient le quota, le handle déclare ce qu'un handle sait faire. Les garder cousus faisait du
 * magasin un module qui se termine par un contrat, au lieu d'un contrat.
 *
 * Les emprunts au magasin passent en argument plutôt que par clôture, ce qui les rend énumérables :
 * l'enregistrement du fichier, le contrôle de quota, le relâchement de l'exclusivité que `close()`
 * doit opérer — et lui seul, `abandon` s'en charge autrement —, et les deux plafonds d'écriture.
 */
function makeHandle({ file, assertQuota, relacherExclusivite, plafond, writeCostBytes }) {
  let closed = false;

  const tuer = () => {
    closed = true;
  };
  file.vivants.add(tuer);

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
      const count = Math.min(source.byteLength, plafond.octets);
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
      // Barrière RETARDÉE : instrument de latence. Le vrai `flush()` est synchrone ; ce mode rend
      // une promesse EN VOL jusqu'à `releaseFlush`, uniquement pour éprouver que l'acquittement
      // du guest attend réellement la résolution de la barrière (`SEC-DURABLE-001`). Il n'est
      // jamais armé en production : par défaut `flush()` reste synchrone et rend `undefined`.
      if (file.gateArmed) {
        file.gateArmed = false;
        return new Promise((resolve, reject) => {
          file.gate = { resolve, reject };
        });
      }
      file.flushes += 1;
      return undefined;
    },
    close() {
      closed = true;
      file.vivants.delete(tuer);
      relacherExclusivite();
    },
  };
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
  /**
   * Plafond d'UN appel `write`, MUTABLE.
   *
   * Il l'est depuis #18, et pour une raison de format : la création d'un volume v3 SCELLE tous ses
   * secteurs, donc elle écrit — là où la création v2 se contentait d'un `truncate`. Un plafond posé
   * dès la construction du double rendrait la création elle-même partielle, et l'épreuve mesurerait
   * une ouverture ratée au lieu d'une écriture du guest. `plafonnerEcriture` permet de créer le
   * volume, PUIS de resserrer le support.
   */
  const plafond = { octets: maxWriteBytes };

  /** @type {Map<string, { bytes: Uint8Array, size: number, lost: boolean, flushes: number, reads: number }>} */
  const files = new Map();
  const open = new Set();

  const fileOf = (name) => {
    let file = files.get(name);
    if (!file) {
      file = creerEnregistrement();
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
      return makeHandle({
        file: fileOf(name),
        assertQuota,
        relacherExclusivite: () => open.delete(name),
        plafond,
        writeCostBytes,
      });
    },
    /** Le fichier disparaît sous les handles ouverts, sans fermeture propre. */
    lose(name) {
      fileOf(name).lost = true;
    },
    /**
     * La MACHINE meurt (#15). Les handles distribués deviennent inutilisables et l'exclusivité est
     * relâchée — un système d'exploitation la reprend quand le processus disparaît —, mais
     * `close()` n'est JAMAIS appelé : c'est toute la différence avec `arreterProprement`, puisque
     * la fermeture d'un `FileSystemSyncAccessHandle` matérialise les écritures en attente.
     *
     * Le fichier, lui, survit avec les octets déjà écrits. Ce double ne modélise PAS de cache
     * d'écriture volatil : tout octet accepté par `write` est dans le fichier avant l'abandon. Une
     * perte d'écriture non barriérée ne peut donc pas être observée ici — seul le vrai support peut
     * la produire, et c'est `tests/vm/resilience-arrets.spec.mjs` qui la mesure.
     */
    abandon(name) {
      const file = fileOf(name);
      for (const tuer of file.vivants) tuer();
      file.vivants.clear();
      open.delete(name);
    },
    /** Le support n'a plus de place : la prochaine barrière du fichier échoue sur le quota. */
    starve(name) {
      fileOf(name).starved = true;
    },
    /**
     * Arme une barrière RETARDÉE : le prochain `flush()` de ce fichier reste en vol jusqu'à
     * `releaseFlush`. C'est l'instrument de latence de #14 : il permet d'observer que le guest reste
     * occupé tant que le flush OPFS n'a pas rendu la main.
     */
    blockFlush(name) {
      fileOf(name).gateArmed = true;
    },
    /** Vrai si une barrière retardée attend d'être libérée. */
    isFlushPending(name) {
      return Boolean(fileOf(name).gate);
    },
    /**
     * Libère une barrière retardée. Sans argument, elle aboutit — le support a fini d'écrire. Avec
     * `fail` (un nom de `DOMException`), elle échoue comme le ferait un support qui disparaît PENDANT
     * l'écriture de la barrière : l'acquittement ne doit alors jamais remonter au guest.
     */
    releaseFlush(name, { fail } = {}) {
      const file = fileOf(name);
      if (!file.gate) throw new Error(`Aucune barrière en attente sur « ${name} ».`);
      const { resolve, reject } = file.gate;
      file.gate = null;
      if (fail) {
        reject(domException(fail, `Barrière du volume « ${name} » interrompue : ${fail}.`));
        return;
      }
      file.flushes += 1;
      resolve();
    },
    /** Resserre le plafond d'un appel `write` APRÈS coup. Voir `plafond` ci-dessus. */
    plafonnerEcriture(octets) {
      plafond.octets = octets;
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
