// Backend de blocs OPFS (#6, `VAULT-PERSIST-001`). Il implémente le contrat de stockage de
// `docs/architecture.md` — lecture exacte ou erreur typée, écriture dont l'incomplétude est
// détectée, barrière dont l'acquittement vaut durabilité, géométrie immuable, fermeture exclusive,
// injection déterministe d'erreurs — au-dessus d'un `FileSystemSyncAccessHandle`.
//
// Il succède au backend mémoire du spike #4, dont il reprend l'API à l'identique pour que
// `v86-buffer-adapter.mjs` fonctionne sans changement. Trois différences seulement :
//
//  - `describe().durable` vaut `true` : ici la barrière atteint réellement le disque ;
//  - l'ouverture est ASYNCHRONE, parce qu'OPFS l'est ;
//  - les échecs du support sont traduits par `opfs-error-mapping.mjs` au lieu d'être inventés.
//
// Le backend ne connaît pas OPFS : il reçoit un ouvreur de handle. C'est ce qui permet aux tests
// unitaires de rejouer quota, handle perdu et écriture partielle sur un double déterministe, et au
// Worker navigateur d'exécuter exactement le même code sur le vrai support.

import {
  SECTOR_SIZE,
  V86_BLOCK_SIZE,
  assertBlockGeometry,
  isBlockGeometry,
} from "./block-geometry.mjs";
import { BlockJournal, JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "./fault-plan.mjs";
import { toStorageError } from "./opfs-error-mapping.mjs";
import { openOpfsSyncAccess } from "./opfs-sync-access.mjs";
import {
  STORAGE_ERROR_CODES,
  StorageError,
  geometryMismatch,
  outOfRange,
} from "./storage-errors.mjs";

export { SECTOR_SIZE, V86_BLOCK_SIZE };

/**
 * Volumes ouverts dans ce contexte. OPFS refuse déjà un second handle exclusif — la table sert à
 * rendre le refus IMMÉDIAT et nommé, avant d'aller déranger le support.
 */
const openVolumes = new Map();

/** Octets réellement traités par une faute programmée, sans jamais dépasser la demande. */
function faultBytes(fault, requested) {
  const proposed = fault.bytes ?? Math.floor(requested / 2 / SECTOR_SIZE) * SECTOR_SIZE;
  return Math.min(Math.max(0, proposed), requested);
}

export class OpfsBlockBackend {
  #name;
  #handle;
  #size;
  #journal;
  #faults;
  #flushDelay;
  #closed = false;
  #handleLost = false;
  #barrier = 0;

  /** Utiliser `openOpfsVolume` : le constructeur ne garantit ni géométrie ni exclusivité. */
  constructor({ name, handle, size, journal, faults, flushDelay }) {
    this.#name = name;
    this.#handle = handle;
    this.#size = size;
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

  /** Géométrie de la session. Elle ne suit jamais le support : elle le contrôle. */
  size() {
    return this.#size;
  }

  /** Le backend annonce ce qu'il est. OPFS est durable, et il le dit sans ambiguïté. */
  describe() {
    return Object.freeze({
      kind: "opfs",
      name: this.#name,
      size: this.#size,
      durable: true,
      sectorSize: SECTOR_SIZE,
      v86BlockSize: V86_BLOCK_SIZE,
    });
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
        `Handle exclusif du volume « ${this.#name} » perdu : le support ne répond plus.`,
        { volume: this.#name },
      );
    }
  }

  #assertRange(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      throw new RangeError(`Plage invalide : offset=${offset} length=${length}.`);
    }
    if (offset + length > this.#size) {
      throw outOfRange(offset, length, this.#size);
    }
  }

  /** Appelle le support et traduit tout échec en état contractuel. Aucune erreur n'est avalée. */
  #support(operation, action, details = {}) {
    try {
      return action();
    } catch (cause) {
      const typed = toStorageError(cause, { operation, volume: this.#name, ...details });
      if (typed.code === STORAGE_ERROR_CODES.handleLost) this.#handleLost = true;
      this.#journal.record(JOURNAL_OPERATIONS.failure, {
        code: typed.code,
        message: typed.message,
        source: operation,
      });
      throw typed;
    }
  }

  /**
   * La géométrie du support est revérifiée avant chaque E/S. Un fichier qui rétrécit sous un volume
   * ouvert transformerait toutes les lectures suivantes en lectures courtes, sans que rien ne dise
   * pourquoi ; `size()` ne doit pas non plus se mettre à suivre la nouvelle taille.
   * `getSize()` est synchrone et local : le coût est celui d'un appel, pas d'une E/S.
   */
  #assertGeometryUnchanged(operation) {
    const observed = this.#support(operation, () => this.#handle.getSize());
    if (observed !== this.#size) {
      throw geometryMismatch(this.#name, {
        observed,
        expected: this.#size,
        reason: "La géométrie du support a changé pendant la session.",
      });
    }
  }

  #applyLostHandle(fault, source, offset, length) {
    if (fault?.kind !== FAULT_KINDS.lostHandle) return;
    this.#handleLost = true;
    this.#journal.record(JOURNAL_OPERATIONS.fault, { kind: fault.kind, source, offset, length });
  }

  /**
   * Lecture exacte. Une lecture courte du support est une ERREUR typée, jamais un tampon complété :
   * le pilote du guest interpréterait les octets manquants comme des données valides.
   *
   * @returns {Promise<Uint8Array>} tampon neuf, détaché du support
   */
  async read(offset, length) {
    this.#assertUsable();
    this.#assertRange(offset, length);
    const fault = this.#faults.consume("read");
    this.#applyLostHandle(fault, "read", offset, length);
    this.#assertUsable();
    this.#assertGeometryUnchanged("read");

    // Une faute programmée ne truque pas le résultat après coup : elle demande RÉELLEMENT moins
    // d'octets au support, et l'erreur qui suit est produite par le même chemin qu'une vraie
    // lecture courte.
    const asked = fault?.kind === FAULT_KINDS.shortRead ? faultBytes(fault, length) : length;
    if (asked !== length) {
      this.#journal.record(JOURNAL_OPERATIONS.fault, {
        kind: fault.kind,
        offset,
        length,
        obtained: asked,
      });
    }

    const target = new Uint8Array(length);
    const obtained = this.#support(
      "read",
      () => this.#handle.read(target.subarray(0, asked), { at: offset }),
      { offset, length },
    );

    if (obtained !== length) {
      throw new StorageError(
        STORAGE_ERROR_CODES.shortRead,
        `Lecture courte : ${obtained} octet(s) rendus sur ${length} demandés à l'offset ${offset} du volume « ${this.#name} ».`,
        { volume: this.#name, offset, requested: length, obtained },
      );
    }

    this.#journal.record(JOURNAL_OPERATIONS.read, { offset, length });
    return target;
  }

  /**
   * Écriture complète ou erreur. Les octets réellement acceptés restent écrits : une coupure doit
   * laisser « ancien état, nouvel état ou erreur explicite », jamais un mensonge.
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
    this.#assertGeometryUnchanged("write");

    const requested = bytes.byteLength;
    const offered =
      fault?.kind === FAULT_KINDS.partialWrite ? faultBytes(fault, requested) : requested;
    if (offered !== requested) {
      this.#journal.record(JOURNAL_OPERATIONS.fault, {
        kind: fault.kind,
        offset,
        length: requested,
        accepted: offered,
      });
    }

    const accepted = this.#support(
      "write",
      () => this.#handle.write(bytes.subarray(0, offered), { at: offset }),
      { offset, length: requested },
    );

    if (accepted !== requested) {
      throw new StorageError(
        STORAGE_ERROR_CODES.partialWrite,
        `Écriture partielle : ${accepted} octet(s) acceptés sur ${requested} à l'offset ${offset} du volume « ${this.#name} ».`,
        { volume: this.#name, offset, requested, accepted },
      );
    }

    this.#journal.record(JOURNAL_OPERATIONS.write, { offset, length: requested });
  }

  /**
   * Barrière de durabilité. Contrairement au backend mémoire de #4, l'acquittement signifie ici que
   * `FileSystemSyncAccessHandle.flush()` est revenu : c'est la promesse de `SEC-DURABLE-001` au
   * niveau du support. Ce que le GUEST en obtient dépend encore du pont de l'ADR 0003, et la
   * barrière durable de bout en bout reste l'objet de #14.
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

    try {
      this.#handle.flush();
    } catch (cause) {
      const typed = toStorageError(cause, { operation: "flush", volume: this.#name, barrier });
      // Un quota atteint pendant la barrière reste un quota : le confondre avec un échec de flush
      // ferait perdre l'information qui permet d'agir. Tout le reste est un échec de barrière.
      const failure =
        typed.code === STORAGE_ERROR_CODES.quotaExceeded
          ? typed
          : new StorageError(
              STORAGE_ERROR_CODES.flushFailed,
              `Barrière de durabilité ${barrier} refusée par le support du volume « ${this.#name} » : ${typed.message}`,
              { volume: this.#name, barrier, cause: typed.context.cause ?? typed.code },
            );
      if (failure.code === STORAGE_ERROR_CODES.handleLost) this.#handleLost = true;
      this.#journal.record(JOURNAL_OPERATIONS.fault, {
        kind: FAULT_KINDS.flushFailure,
        barrier,
        code: failure.code,
      });
      throw failure;
    }

    this.#journal.record(JOURNAL_OPERATIONS.flushAck, { barrier });
  }

  /**
   * Fermeture exclusive. Elle rend le handle au support ET libère le nom : c'est le transfert de
   * propriété du volume, et c'est ce qui rend la réouverture possible dans la même session.
   * L'échec de la fermeture est remonté, jamais avalé — mais la propriété est relâchée d'abord,
   * pour qu'un support récalcitrant ne bloque pas définitivement le nom.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    openVolumes.delete(this.#name);
    this.#journal.record(JOURNAL_OPERATIONS.close, { volume: this.#name });

    try {
      this.#handle.close();
    } catch (cause) {
      throw toStorageError(cause, { operation: "close", volume: this.#name });
    }
  }
}

/** Ferme un handle après une ouverture ratée, sans jamais masquer l'erreur d'origine. */
function abandonHandle(handle, name, original) {
  try {
    handle.close();
  } catch (cause) {
    return new StorageError(
      STORAGE_ERROR_CODES.supportFailure,
      `${original.message} La fermeture de secours du volume « ${name} » a elle aussi échoué : ${cause?.name ?? cause}.`,
      { volume: name, initial: original.code, cause: cause?.name ?? "Error" },
    );
  }
  return original;
}

/**
 * Résout la géométrie de la session à partir de la taille déclarée et de celle du fichier.
 * Un fichier vide est alloué ; un fichier existant impose sa taille et n'est jamais retaillé.
 */
function resolveGeometry({ name, declared, observed }) {
  if (observed === 0) {
    if (declared === undefined) {
      throw geometryMismatch(name, {
        observed,
        expected: null,
        reason: "Volume absent ou vide et aucune géométrie déclarée : rien à ouvrir.",
      });
    }
    return { size: declared, allocate: true };
  }
  if (declared !== undefined && declared !== observed) {
    throw geometryMismatch(name, {
      observed,
      expected: declared,
      reason: "Un volume existant n'est jamais retaillé en silence ; exporter puis migrer.",
    });
  }
  if (!isBlockGeometry(observed)) {
    throw geometryMismatch(name, {
      observed,
      expected: null,
      reason: `Le volume existant n'est pas un multiple de ${SECTOR_SIZE} octets.`,
    });
  }
  return { size: observed, allocate: false };
}

/**
 * Ouvre un volume OPFS en exclusivité.
 *
 * @param {{ name?: string, size?: number, journal?: BlockJournal,
 *           faults?: import("./fault-plan.mjs").FaultPlan, flushDelay?: number,
 *           openHandle?: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 *   `size` est facultative : à la réouverture, la géométrie est RELUE du fichier au lieu d'être
 *   supposée. Fournie, elle doit correspondre exactement.
 *   `openHandle` est le point d'injection du support : le vrai OPFS en production, un double
 *   déterministe dans les tests unitaires.
 * @returns {Promise<OpfsBlockBackend>}
 */
export async function openOpfsVolume({
  name = "vault",
  size,
  journal = new BlockJournal(),
  faults = createFaultPlan(),
  flushDelay = 0,
  openHandle = openOpfsSyncAccess,
} = {}) {
  if (openVolumes.has(name)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.busy,
      `Le volume « ${name} » est déjà ouvert en exclusivité dans ce contexte.`,
      { volume: name },
    );
  }
  if (size !== undefined) assertBlockGeometry(size);

  // L'ouvreur peut être le vrai OPFS, qui rend déjà des erreurs typées, ou un double qui rend des
  // `DOMException` brutes comme le ferait le moteur : les deux passent par la même traduction.
  let handle;
  try {
    handle = await openHandle(name);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open", volume: name });
  }

  let observed;
  try {
    observed = handle.getSize();
  } catch (cause) {
    throw abandonHandle(handle, name, toStorageError(cause, { operation: "size", volume: name }));
  }

  let geometry;
  try {
    geometry = resolveGeometry({ name, declared: size, observed });
  } catch (error) {
    throw abandonHandle(handle, name, error);
  }

  if (geometry.allocate) {
    try {
      handle.truncate(geometry.size);
    } catch (cause) {
      throw abandonHandle(
        handle,
        name,
        toStorageError(cause, { operation: "allocate", volume: name, length: geometry.size }),
      );
    }
  }

  const backend = new OpfsBlockBackend({
    name,
    handle,
    size: geometry.size,
    journal,
    faults,
    flushDelay,
  });
  openVolumes.set(name, backend);
  return backend;
}
