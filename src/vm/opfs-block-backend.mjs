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
import { readCountFailure, toStorageError, writeCountFailure } from "./opfs-error-mapping.mjs";
import { GenerationStore } from "./generation-store.mjs";
import { generationJournalName, openOpfsSyncAccess } from "./opfs-sync-access.mjs";
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
  #generation;
  #closed = false;
  #handleLost = false;
  #barrier = 0;

  /** Utiliser `openOpfsVolume` : le constructeur ne garantit ni géométrie ni exclusivité. */
  constructor({ name, handle, size, journal, faults, flushDelay, generation = null }) {
    this.#name = name;
    this.#handle = handle;
    this.#size = size;
    this.#journal = journal;
    this.#faults = faults;
    this.#flushDelay = flushDelay;
    this.#generation = generation;
  }

  /**
   * Magasin de générations du volume, ou `null` si le volume est ouvert SANS transaction.
   *
   * L'absence n'est pas un repli silencieux : `openOpfsVolume` en installe toujours un, et seuls les
   * bancs qui construisent le backend à la main peuvent s'en passer — auquel cas `describe()` le
   * publie, et aucune atomicité n'est prétendue.
   */
  get generation() {
    return this.#generation;
  }

  /** Installe le magasin après l'ouverture : il a besoin du backend pour lire et écrire le volume. */
  installerGeneration(magasin) {
    if (this.#generation !== null) {
      throw new Error(`Le volume « ${this.#name} » a déjà un magasin de générations.`);
    }
    this.#generation = magasin;
  }

  /**
   * Accès BRUT au support, sans faute programmée, sans superposition et sans journal d'E/S. Réservé
   * au magasin de générations, qui est la seule pièce ayant à écrire le volume lui-même : les fautes
   * de #15 visent les gestes du GUEST, et les compter deux fois déplacerait les points de coupure.
   */
  lireSupportBrut(offset, longueur) {
    const cible = new Uint8Array(longueur);
    const obtenus = this.#support("read", () => this.#handle.read(cible, { at: offset }), {
      offset,
      length: longueur,
    });
    const echec = readCountFailure(obtenus, { requested: longueur, volume: this.#name, offset });
    if (echec !== null) throw echec;
    return cible;
  }

  /** Écrit dans le volume au nom du magasin. Un compte inexact reste un échec typé (#73). */
  ecrireSupportBrut(offset, octets) {
    const acceptes = this.#support("write", () => this.#handle.write(octets, { at: offset }), {
      offset,
      length: octets.byteLength,
    });
    const echec = writeCountFailure(acceptes, {
      requested: octets.byteLength,
      volume: this.#name,
      offset,
    });
    if (echec !== null) throw echec;
  }

  /** Barrière du volume, franchie par le point de contrôle. Elle n'acquitte rien au guest. */
  barriereSupportBrute() {
    return this.#awaitSupport("flush", () => this.#handle.flush());
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
      // Ce que le volume promet d'une coupure. `false` n'est pas une panne : c'est un banc qui a
      // construit le backend sans magasin, et qui ne doit pas pouvoir se croire transactionnel.
      transactionnel: this.#generation !== null,
      generation: this.#generation?.generationValidee ?? null,
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

  /** Traduit un échec du support en état contractuel, marque le handle perdu et le journalise. */
  #mapSupportFailure(cause, operation, details) {
    const typed = toStorageError(cause, { operation, volume: this.#name, ...details });
    if (typed.code === STORAGE_ERROR_CODES.handleLost) this.#handleLost = true;
    this.#journal.record(JOURNAL_OPERATIONS.failure, {
      code: typed.code,
      message: typed.message,
      source: operation,
    });
    return typed;
  }

  /** Appelle le support SYNCHRONE et traduit tout échec en état contractuel. Rien n'est avalé. */
  #support(operation, action, details = {}) {
    try {
      return action();
    } catch (cause) {
      throw this.#mapSupportFailure(cause, operation, details);
    }
  }

  /**
   * Appelle le support et ATTEND sa résolution avant de rendre la main. Réservé à la barrière : elle
   * est la seule opération dont le guest doit attendre l'aboutissement RÉEL, parce que son
   * acquittement vaut promesse de durabilité (`SEC-DURABLE-001`). Un `FileSystemSyncAccessHandle`
   * réel rend `undefined` de façon synchrone — `await undefined` ne coûte alors qu'une microtâche —,
   * mais attendre garantit qu'un support dont la barrière n'a pas encore abouti n'est jamais acquitté
   * par anticipation.
   */
  async #awaitSupport(operation, action, details = {}) {
    try {
      return await action();
    } catch (cause) {
      throw this.#mapSupportFailure(cause, operation, details);
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

    // Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite : un support qui rend un
    // code d'échec casté en non signé (#73) n'a pas fait une lecture courte, il n'a rien lu.
    const echecDeLecture = readCountFailure(obtained, {
      requested: length,
      volume: this.#name,
      offset,
    });
    if (echecDeLecture !== null) throw echecDeLecture;

    // La génération EN COURS se superpose au volume : l'écrivain se relit. Elle n'est visible que
    // de lui — un lecteur qui rouvrirait le volume ne verrait que la dernière génération validée.
    if (this.#generation !== null) this.#generation.superposer(offset, target);

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

    // L'écriture va dans la GÉNÉRATION EN COURS, pas dans le volume (#16, ADR 0014). Les octets
    // atteignent bien le support — le journal voisin est un fichier comme un autre, et une déchirure
    // y est aussi réelle qu'ailleurs —, mais ils ne deviennent l'état du volume qu'à la validation.
    if (this.#generation !== null) {
      await this.#awaitSupport("write", () => this.#generation.deposer(offset, bytes.subarray(0, offered)), {
        offset,
        length: requested,
      });
      if (offered !== requested) {
        throw new StorageError(
          STORAGE_ERROR_CODES.partialWrite,
          `Écriture partielle : ${offered} octet(s) acceptés sur ${requested} à l'offset ${offset}.`,
          { volume: this.#name, offset, requested, accepted: offered },
        );
      }
      this.#journal.record(JOURNAL_OPERATIONS.write, { offset, length: requested });
      return;
    }

    const accepted = this.#support(
      "write",
      () => this.#handle.write(bytes.subarray(0, offered), { at: offset }),
      { offset, length: requested },
    );

    // Même règle qu'en lecture : `4294967288` n'est pas « plus d'octets qu'on n'en demandait »,
    // c'est `FILE_ERROR_NO_SPACE` casté en non signé sur 32 bits (#73). L'écriture partielle et le
    // manque de place ont des remèdes différents ; les confondre les rendrait tous deux inutiles.
    const echecDEcriture = writeCountFailure(accepted, {
      requested,
      volume: this.#name,
      offset,
    });
    if (echecDEcriture !== null) throw echecDEcriture;

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
    // Depuis #16 la barrière ne touche plus le fichier du VOLUME — elle scelle le journal voisin.
    // Sans ce contrôle, un volume disparu sous la session ne serait plus découvert par la barrière,
    // et la perte ne se révélerait qu'au point de contrôle suivant. Le coût est un `getSize()`
    // synchrone et local, pas une E/S.
    this.#assertGeometryUnchanged("flush");

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
      // Passer par `#awaitSupport` et non par un `try` local : c'est lui qui pose `#handleLost` et
      // journalise la panne. Un `catch` parallèle laisserait le volume se croire sain après une
      // perte de support découverte par la barrière. L'ATTENTE est le cœur de #14 : le `flush-ack`
      // ne sera enregistré qu'APRÈS que la barrière du support a réellement rendu la main.
      // Avec un magasin de générations, la barrière VALIDE la génération en cours : la charge est
      // franchie par une barrière, puis la racine est écrite et franchie à son tour. C'est ce geste,
      // et lui seul, qui autorise l'acquittement — `SEC-DURABLE-001` porte désormais sur une
      // génération entière, pas sur des écritures isolées.
      await this.#awaitSupport(
        "flush",
        () => (this.#generation === null ? this.#handle.flush() : this.#generation.valider()),
        { barrier },
      );
    } catch (typed) {
      // Un quota atteint pendant la barrière reste un quota, et un handle perdu reste un handle
      // perdu : les trois états se corrigent différemment — libérer de la place, rouvrir le
      // volume, réessayer — et les fondre en « échec de barrière » effacerait cette différence.
      const preserved =
        typed.code === STORAGE_ERROR_CODES.quotaExceeded ||
        typed.code === STORAGE_ERROR_CODES.handleLost;
      const failure = preserved
        ? typed
        : new StorageError(
            STORAGE_ERROR_CODES.flushFailed,
            `Barrière de durabilité ${barrier} refusée par le support du volume « ${this.#name} » : ${typed.message}`,
            { volume: this.#name, barrier, cause: typed.context?.cause ?? typed.code },
          );
      this.#journal.record(JOURNAL_OPERATIONS.fault, {
        kind: FAULT_KINDS.flushFailure,
        barrier,
        code: failure.code,
      });
      throw failure;
    }

    this.#journal.record(JOURNAL_OPERATIONS.flushAck, { barrier });

    // Le POINT DE CONTRÔLE vient APRÈS l'acquittement, et n'en fait pas partie : les octets sont
    // déjà durables, le ranger ne promet rien de neuf. Il est amorti — une génération sur beaucoup —
    // parce que recopier à chaque barrière doublerait le coût de chaque `fsync` du guest.
    if (this.#generation !== null && this.#generation.pointDeControleDu) {
      await this.#awaitSupport("flush", () => this.#generation.pointDeControle(), { barrier });
      this.#journal.record(JOURNAL_OPERATIONS.mark, { kind: "point-de-controle", barrier });
    }
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

    // Une fermeture PROPRE range la génération validée dans le volume : l'export (#11), la
    // restauration (#12) et la migration (#13) lisent le FICHIER, et doivent y trouver la génération
    // validée sans rien savoir du journal. Une génération non validée n'est PAS rangée — personne ne
    // l'a acquittée, et la prochaine ouverture l'écartera.
    let rangement = null;
    try {
      if (this.#generation !== null && this.#generation.rangeable) {
        await this.#generation.pointDeControle();
      }
    } catch (cause) {
      rangement = toStorageError(cause, { operation: "checkpoint", volume: this.#name });
    }

    try {
      this.#generation?.close();
      this.#handle.close();
    } catch (cause) {
      throw rangement ?? toStorageError(cause, { operation: "close", volume: this.#name });
    }
    if (rangement !== null) throw rangement;
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
  transactionnel = true,
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

  if (transactionnel) {
    try {
      backend.installerGeneration(
        await ouvrirGeneration({ name, size: geometry.size, backend, openHandle }),
      );
    } catch (cause) {
      // Le handle du volume est rendu avant de propager : un refus de génération ne doit pas laisser
      // le nom occupé par un volume que personne ne détient.
      await backend.close().catch(() => {});
      throw cause;
    }
  }

  openVolumes.set(name, backend);
  return backend;
}

/**
 * Ouvre le journal de génération voisin et RÉCUPÈRE. C'est ici que se joue la promesse de #16 : au
 * retour, le volume porte la dernière génération VALIDÉE, et rien d'autre.
 */
async function ouvrirGeneration({ name, size, backend, openHandle }) {
  const nomJournal = generationJournalName(name);
  let handle;
  try {
    handle = await openHandle(nomJournal);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open-generation", volume: name });
  }
  try {
    return await ouvrirMagasin({ name, size, backend, handle });
  } catch (cause) {
    try {
      handle.close();
    } catch {
      // La fermeture de secours ne doit jamais masquer la raison du refus.
    }
    throw cause;
  }
}

async function ouvrirMagasin({ name, size, backend, handle }) {
  try {
    return await GenerationStore.ouvrir({
      volume: name,
      handle,
      tailleVolume: size,
      lireVolume: (offset, longueur) => backend.lireSupportBrut(offset, longueur),
      ecrireVolume: (offset, octets) => backend.ecrireSupportBrut(offset, octets),
      barriereVolume: () => backend.barriereSupportBrute(),
    });
  } catch (cause) {
    // Un échec du SUPPORT pendant la récupération — quota, handle perdu — reste un état contractuel
    // nommé. Les refus propres au journal (`VAULT_STORAGE_GENERATION_*`) traversent tels quels.
    throw toStorageError(cause, { operation: "recover-generation", volume: name });
  }
}
