// Backend de blocs en mémoire, conforme au contrat de `docs/architecture.md` :
// `read` exacte ou erreur typée, `write` avec détection d'écriture partielle, `flush` dont
// l'acquittement vaut durabilité, `size` stable, fermeture exclusive, injection déterministe.
//
// La mémoire n'est évidemment pas durable ; ce backend sert à MESURER les sémantiques exigées par
// v86 avant d'écrire le backend OPFS de production (#6). Sa `flush` acquitte une durabilité
// simulée, et il le dit : `durable` vaut `false` dans son descripteur.

import { SECTOR_SIZE, assertBlockGeometry } from "./block-geometry.mjs";
import { BlockJournal, JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "./fault-plan.mjs";
import { STORAGE_ERROR_CODES, StorageError, outOfRange } from "./storage-errors.mjs";

// La géométrie est partagée avec le backend OPFS de #6 : deux définitions du secteur pourraient
// diverger sans que rien ne le signale. `SECTOR_SIZE` reste réexporté, les appelants du spike #4
// l'important d'ici.
export { SECTOR_SIZE };

const openVolumes = new Map();

export class MemoryBlockBackend {
  #name;
  #bytes;
  #journal;
  #faults;
  #flushDelay;
  #closed = false;
  #handleLost = false;
  #barrier = 0;

  /** Utiliser `openMemoryVolume` : le constructeur ne garantit pas l'exclusivité. */
  constructor({ name, size, journal, faults, flushDelay }) {
    assertBlockGeometry(size);
    this.#name = name;
    this.#bytes = new Uint8Array(size);
    this.#journal = journal;
    this.#faults = faults;
    this.#flushDelay = flushDelay;
  }

  get name() {
    return this.#name;
  }

  get journal() {
    return this.#journal;
  }

  get faults() {
    return this.#faults;
  }

  /** Géométrie immuable pendant la session. */
  size() {
    return this.#bytes.byteLength;
  }

  /** Le backend annonce ce qu'il est : la mémoire n'est pas une promesse de durabilité. */
  describe() {
    return Object.freeze({ kind: "memory", name: this.#name, size: this.size(), durable: false });
  }

  #assertUsable() {
    if (this.#closed) {
      throw new StorageError(
        STORAGE_ERROR_CODES.closed,
        `Volume « ${this.#name} » fermé : plus aucune E/S n'est acceptée.`,
        { volume: this.#name },
      );
    }
    if (this.#handleLost) {
      throw new StorageError(
        STORAGE_ERROR_CODES.handleLost,
        `Handle exclusif du volume « ${this.#name} » perdu.`,
        { volume: this.#name },
      );
    }
  }

  #assertRange(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      throw new RangeError(`Plage invalide : offset=${offset} length=${length}.`);
    }
    if (offset + length > this.size()) {
      throw outOfRange(offset, length, this.size());
    }
  }

  /**
   * Lecture exacte. Une lecture courte du support est une ERREUR typée, jamais un tampon tronqué :
   * le pilote du guest interpréterait des octets manquants comme des données valides.
   * @returns {Promise<Uint8Array>} copie détachée du support
   */
  async read(offset, length) {
    this.#assertUsable();
    this.#assertRange(offset, length);
    const fault = this.#faults.consume("read");
    this.#applyLostHandle(fault, "read", offset, length);
    this.#assertUsable();

    let obtained = length;
    if (fault?.kind === FAULT_KINDS.shortRead) {
      obtained = fault.bytes ?? Math.max(0, Math.floor(length / 2 / SECTOR_SIZE) * SECTOR_SIZE);
      this.#journal.record(JOURNAL_OPERATIONS.fault, {
        kind: fault.kind,
        offset,
        length,
        obtained,
      });
    }

    if (obtained !== length) {
      throw new StorageError(
        STORAGE_ERROR_CODES.shortRead,
        `Lecture courte : ${obtained} octet(s) rendus sur ${length} demandés à l'offset ${offset}.`,
        { offset, requested: length, obtained },
      );
    }

    const copy = this.#bytes.slice(offset, offset + length);
    this.#journal.record(JOURNAL_OPERATIONS.read, { offset, length });
    return copy;
  }

  /**
   * Écriture complète ou erreur. Les octets réellement acceptés restent écrits : la coupure doit
   * laisser « ancien état, nouvel état ou erreur explicite », pas un mensonge.
   */
  async write(offset, bytes) {
    this.#assertUsable();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Une écriture attend un Uint8Array.");
    }
    this.#assertRange(offset, bytes.byteLength);
    const fault = this.#faults.consume("write");
    this.#applyLostHandle(fault, "write", offset, bytes.byteLength);
    this.#assertUsable();

    let accepted = bytes.byteLength;
    if (fault?.kind === FAULT_KINDS.partialWrite) {
      accepted =
        fault.bytes ?? Math.max(0, Math.floor(bytes.byteLength / 2 / SECTOR_SIZE) * SECTOR_SIZE);
      this.#journal.record(JOURNAL_OPERATIONS.fault, {
        kind: fault.kind,
        offset,
        length: bytes.byteLength,
        accepted,
      });
    }

    this.#bytes.set(bytes.subarray(0, accepted), offset);

    if (accepted !== bytes.byteLength) {
      throw new StorageError(
        STORAGE_ERROR_CODES.partialWrite,
        `Écriture partielle : ${accepted} octet(s) acceptés sur ${bytes.byteLength} à l'offset ${offset}.`,
        { offset, requested: bytes.byteLength, accepted },
      );
    }

    this.#journal.record(JOURNAL_OPERATIONS.write, { offset, length: bytes.byteLength });
  }

  /**
   * Barrière de durabilité. L'acquittement n'est rendu qu'après le délai simulé : le pont de
   * durabilité doit donc réellement attendre, comme il devra attendre `FileSystemSyncAccessHandle`.
   */
  async flush() {
    this.#assertUsable();
    const fault = this.#faults.consume("flush");
    this.#applyLostHandle(fault, "flush", 0, 0);
    this.#assertUsable();

    const barrier = this.#barrier++;
    this.#journal.record(JOURNAL_OPERATIONS.flush, { barrier });

    if (this.#flushDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#flushDelay));
    }

    if (fault?.kind === FAULT_KINDS.flushFailure) {
      this.#journal.record(JOURNAL_OPERATIONS.fault, { kind: fault.kind, barrier });
      throw new StorageError(
        STORAGE_ERROR_CODES.flushFailed,
        `Barrière de durabilité ${barrier} en échec sur le volume « ${this.#name} ».`,
        { volume: this.#name, barrier },
      );
    }

    this.#journal.record(JOURNAL_OPERATIONS.flushAck, { barrier });
  }

  #applyLostHandle(fault, source, offset, length) {
    if (fault?.kind !== FAULT_KINDS.lostHandle) return;
    this.#handleLost = true;
    this.#journal.record(JOURNAL_OPERATIONS.fault, {
      kind: fault.kind,
      source,
      offset,
      length,
    });
  }

  /** Fermeture exclusive : le nom redevient disponible, les E/S ultérieures échouent. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#journal.record(JOURNAL_OPERATIONS.close, { volume: this.#name });
    openVolumes.delete(this.#name);
  }

  /** Copie du contenu, pour vérifier une écriture dans un test. Jamais utilisée par l'émulateur. */
  snapshot(offset = 0, length = this.size()) {
    this.#assertRange(offset, length);
    return this.#bytes.slice(offset, offset + length);
  }
}

/**
 * Ouvre un volume mémoire en exclusivité. Un second appel sur le même nom échoue tant que le
 * premier n'est pas fermé : deux écrivains sur un volume ne sont jamais un cas acceptable.
 *
 * @param {{ name?: string, size: number, journal?: BlockJournal, faults?: import("./fault-plan.mjs").FaultPlan,
 *           flushDelay?: number }} options
 */
export function openMemoryVolume({
  name = "vault-memoire",
  size,
  journal = new BlockJournal(),
  faults = createFaultPlan(),
  flushDelay = 0,
} = {}) {
  if (openVolumes.has(name)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.busy,
      `Le volume « ${name} » est déjà ouvert en exclusivité.`,
      { volume: name },
    );
  }
  const backend = new MemoryBlockBackend({ name, size, journal, faults, flushDelay });
  openVolumes.set(name, backend);
  return backend;
}
