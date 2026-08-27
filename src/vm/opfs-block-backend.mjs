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
//
// Deux voisins portent ce qui n'est pas une décision d'E/S, et `openOpfsVolume` est réexporté ici
// pour que les appelants n'aient rien à changer : `opfs-backend-support.mjs` traduit chaque
// sollicitation du support en état contractuel, `opfs-volume-ouverture.mjs` établit géométrie,
// exclusivité et génération récupérée.

import { SECTOR_SIZE, V86_BLOCK_SIZE } from "./block-geometry.mjs";
import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { FAULT_KINDS } from "./fault-plan.mjs";
import { AccesSupport } from "./opfs-backend-support.mjs";
import { readCountFailure, toStorageError, writeCountFailure } from "./opfs-error-mapping.mjs";
import { libererVolume } from "./opfs-volume-registry.mjs";
import { STORAGE_ERROR_CODES, StorageError, outOfRange } from "./storage-errors.mjs";

export { SECTOR_SIZE, V86_BLOCK_SIZE };
export { openOpfsVolume } from "./opfs-volume-ouverture.mjs";

/** Octets réellement traités par une faute programmée, sans jamais dépasser la demande. */
function faultBytes(fault, requested) {
  const proposed = fault.bytes ?? Math.floor(requested / 2 / SECTOR_SIZE) * SECTOR_SIZE;
  return Math.min(Math.max(0, proposed), requested);
}

export class OpfsBlockBackend {
  #name;
  #acces;
  #size;
  #journal;
  #faults;
  #flushDelay;
  #generation;
  #rangement = null;
  #rangementEnCours = null;
  #dureeRangementMaxMs = 0;
  #barrier = 0;

  /** Utiliser `openOpfsVolume` : le constructeur ne garantit ni géométrie ni exclusivité. */
  constructor({ name, handle, size, journal, faults, flushDelay, generation = null }) {
    this.#name = name;
    this.#acces = new AccesSupport({ volume: name, handle, journal });
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
    const obtenus = this.#acces.lire(cible, offset, { offset, length: longueur });
    const echec = readCountFailure(obtenus, { requested: longueur, volume: this.#name, offset });
    if (echec !== null) throw echec;
    return cible;
  }

  /** Écrit dans le volume au nom du magasin. Un compte inexact reste un échec typé (#73). */
  ecrireSupportBrut(offset, octets) {
    const acceptes = this.#acces.ecrire(octets, offset, {
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
    return this.#acces.barriere();
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

  #assertRange(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      throw new RangeError(`Plage invalide : offset=${offset} length=${length}.`);
    }
    if (offset + length > this.#size) {
      throw outOfRange(offset, length, this.#size);
    }
  }

  #applyLostHandle(fault, source, offset, length) {
    if (fault?.kind !== FAULT_KINDS.lostHandle) return;
    this.#acces.marquerPerdu();
    this.#journal.record(JOURNAL_OPERATIONS.fault, { kind: fault.kind, source, offset, length });
  }

  /**
   * Lecture exacte. Une lecture courte du support est une ERREUR typée, jamais un tampon complété :
   * le pilote du guest interpréterait les octets manquants comme des données valides.
   *
   * @returns {Promise<Uint8Array>} tampon neuf, détaché du support
   */
  async read(offset, length) {
    this.#acces.assertUtilisable();
    // Un rangement en cours va tronquer le journal et vider l'index : lire pendant qu'il court
    // rendrait un tampon superposé à partir de positions sur le point de disparaître.
    await this.#attendreRangement();
    this.#acces.assertUtilisable();
    this.#assertRange(offset, length);
    const fault = this.#faults.consume("read");
    this.#applyLostHandle(fault, "read", offset, length);
    this.#acces.assertUtilisable();
    this.#acces.assertGeometrieInchangee("read", this.#size);

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
    const obtained = this.#acces.lire(target.subarray(0, asked), offset, { offset, length });

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
    this.#acces.assertUtilisable();
    await this.#attendreRangement();
    this.#acces.assertUtilisable();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Une écriture attend un Uint8Array.");
    }
    this.#assertRange(offset, bytes.byteLength);
    const fault = this.#faults.consume("write");
    this.#applyLostHandle(fault, "write", offset, bytes.byteLength);
    this.#acces.assertUtilisable();
    this.#acces.assertGeometrieInchangee("write", this.#size);

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

    if (this.#generation !== null) {
      await this.#deposerDansGeneration(offset, bytes.subarray(0, offered), requested);
    } else {
      this.#ecrireDansLeVolume(offset, bytes.subarray(0, offered), requested);
    }
    this.#journal.record(JOURNAL_OPERATIONS.write, { offset, length: requested });
  }

  /**
   * Dépose une écriture dans la GÉNÉRATION EN COURS (#16, ADR 0014).
   *
   * Les octets atteignent bien le support — le journal voisin est un fichier comme un autre, et une
   * déchirure y est aussi réelle qu'ailleurs —, mais ils ne deviennent l'état du volume qu'à la
   * validation. Une écriture partielle programmée est donc réellement partielle DANS LE JOURNAL, et
   * l'erreur typée qui suit ferme la génération : elle ne sera jamais validée.
   */
  async #deposerDansGeneration(offset, offerts, requested) {
    await this.#acces.attendre("write", () => this.#generation.deposer(offset, offerts), {
      offset,
      length: requested,
    });
    if (offerts.byteLength !== requested) {
      throw new StorageError(
        STORAGE_ERROR_CODES.partialWrite,
        `Écriture partielle : ${offerts.byteLength} octet(s) acceptés sur ${requested} à l'offset ${offset}.`,
        { volume: this.#name, offset, requested, accepted: offerts.byteLength },
      );
    }
  }

  /**
   * Écrit DIRECTEMENT dans le volume, sans génération. Réservé aux chemins qui réécrivent un volume
   * entier et portent leur propre atomicité — préparation d'image, restauration (ADR 0014).
   */
  #ecrireDansLeVolume(offset, offerts, requested) {
    const accepted = this.#acces.ecrire(offerts, offset, { offset, length: requested });

    // Même règle qu'en lecture : `4294967288` n'est pas « plus d'octets qu'on n'en demandait »,
    // c'est `FILE_ERROR_NO_SPACE` casté en non signé sur 32 bits (#73). L'écriture partielle et le
    // manque de place ont des remèdes différents ; les confondre les rendrait tous deux inutiles.
    const echec = writeCountFailure(accepted, { requested, volume: this.#name, offset });
    if (echec !== null) throw echec;
  }

  /**
   * OUVRE une barrière : contrôles de seuil, panne injectée, numérotation et inscription au
   * journal. Au retour, la barrière est annoncée mais le support n'a pas encore été sollicité.
   *
   * Le contrôle de géométrie a sa raison propre : depuis #16 la barrière ne touche plus le fichier
   * du VOLUME, elle scelle le journal voisin. Sans lui, un volume disparu sous la session ne serait
   * découvert qu'au point de contrôle suivant. Le coût est un `getSize()` local, pas une E/S.
   *
   * @returns {Promise<number>} numéro de la barrière ouverte
   */
  async #ouvrirBarriere() {
    this.#acces.assertUtilisable();
    await this.#attendreRangement();
    this.#acces.assertUtilisable();
    const fault = this.#faults.consume("flush");
    this.#applyLostHandle(fault, "flush", 0, 0);
    this.#acces.assertUtilisable();
    this.#acces.assertGeometrieInchangee("flush", this.#size);

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

    return barrier;
  }

  /**
   * Qualifie un refus du support et l'inscrit au journal. Rend l'erreur à jeter plutôt que de la
   * jeter : le `throw` reste visible à l'endroit où la barrière échoue.
   *
   * Un quota atteint pendant la barrière reste un quota, et un handle perdu reste un handle perdu :
   * les trois états se corrigent différemment — libérer de la place, rouvrir le volume, réessayer —
   * et les fondre en « échec de barrière » effacerait cette différence.
   */
  #echecDeBarriere(typed, barrier) {
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
    return failure;
  }

  /**
   * Barrière de durabilité. Contrairement au backend mémoire de #4, l'acquittement signifie ici que
   * `FileSystemSyncAccessHandle.flush()` est revenu : c'est la promesse de `SEC-DURABLE-001` au
   * niveau du support. Ce que le GUEST en obtient dépend encore du pont de l'ADR 0003, et la
   * barrière durable de bout en bout reste l'objet de #14.
   */
  async flush() {
    const barrier = await this.#ouvrirBarriere();

    try {
      // Passer par l'accès au support et non par un `try` local : c'est lui qui marque le handle
      // perdu et journalise la panne. Un `catch` parallèle laisserait le volume se croire sain après
      // une perte de support découverte par la barrière. L'ATTENTE est le cœur de #14 : le
      // `flush-ack` ne sera enregistré qu'APRÈS que la barrière du support a réellement rendu la
      // main. Avec un magasin de générations, la barrière VALIDE la génération en cours : la charge
      // est franchie par une barrière, puis la racine est écrite et franchie à son tour. C'est ce
      // geste, et lui seul, qui autorise l'acquittement — `SEC-DURABLE-001` porte désormais sur une
      // génération entière, pas sur des écritures isolées.
      if (this.#generation === null) {
        await this.#acces.barriere({ barrier });
      } else {
        await this.#acces.attendre("flush", () => this.#generation.valider(), { barrier });
      }
    } catch (typed) {
      throw this.#echecDeBarriere(typed, barrier);
    }

    this.#journal.record(JOURNAL_OPERATIONS.flushAck, { barrier });

    // Le POINT DE CONTRÔLE vient APRÈS l'acquittement, et il n'est PAS attendu ici. La nuance est
    // celle que la revue de #90 a relevée : « après l'acquittement » était vrai de la DURABILITÉ —
    // les octets étaient déjà sûrs — mais faux de la COMMANDE ATA. Tant que cette promesse n'était
    // pas résolue, `v86-buffer-adapter` ne levait pas BSY et n'émettait pas l'IRQ : le guest restait
    // bloqué pendant la relecture, la réécriture de plusieurs mébioctets et la barrière du volume.
    // Le rangement est donc LANCÉ et laissé courir ; toute E/S ultérieure l'attend, parce qu'il
    // tronque le journal et vide l'index — deux choses qu'une écriture concurrente ne survivrait pas.
    if (this.#generation !== null && this.#generation.pointDeControleDu) {
      this.#rangementEnCours = this.#rangerApresAcquittement(barrier);
    }
  }

  /**
   * Attend le rangement en cours, s'il y en a un. Appelé au seuil de chaque E/S.
   *
   * C'est la seule sérialisation nécessaire : le rangement recopie la charge validée dans le volume,
   * PUIS tronque le journal et vide l'index. Une écriture qui se glisserait entre les deux verrait
   * sa position d'index effacée. L'attente ne coûte donc rien tant qu'aucun rangement ne court —
   * c'est-à-dire presque toujours, puisqu'il est amorti au-delà de 8 Mio de charge.
   */
  async #attendreRangement() {
    if (this.#rangementEnCours === null) return;
    const encours = this.#rangementEnCours;
    this.#rangementEnCours = null;
    await encours;
  }

  /**
   * Range la génération validée, APRÈS que la barrière a été acquittée.
   *
   * Son échec **ne remonte pas** au guest, et c'est délibéré : la barrière a réussi, les octets sont
   * durables dans le journal, et la prochaine ouverture les rejouera. Propager l'échec dirait au
   * guest « ta barrière a échoué » alors qu'elle a abouti — un mensonge dans le sens inverse de celui
   * que `SEC-DURABLE-001` interdit, et qui de surcroît marquerait l'adaptateur v86 comme fatal, donc
   * tuerait la session entière pour un geste de rangement.
   *
   * Ce n'est pas pour autant un échec avalé : il est JOURNALISÉ avec son code, publié par
   * `dernierRangement`, et il se signalera de lui-même — un journal qui ne se vide plus finit par
   * atteindre son plafond, et `VAULT_STORAGE_GENERATION_OVERFLOW` est levé, lui, à l'écriture.
   */
  async #rangerApresAcquittement(barrier) {
    const depart = performance.now();
    try {
      await this.#generation.pointDeControle();
      this.#rangement = null;
      const dureeMs = Number((performance.now() - depart).toFixed(1));
      this.#dureeRangementMaxMs = Math.max(this.#dureeRangementMaxMs, dureeMs);
      this.#journal.record(JOURNAL_OPERATIONS.mark, {
        kind: "point-de-controle",
        barrier,
        dureeMs,
      });
    } catch (cause) {
      const typed = toStorageError(cause, { operation: "checkpoint", volume: this.#name });
      if (typed.code === STORAGE_ERROR_CODES.handleLost) this.#acces.marquerPerdu();
      this.#rangement = typed.toJSON();
      this.#journal.record(JOURNAL_OPERATIONS.failure, {
        code: typed.code,
        message: typed.message,
        source: "checkpoint",
      });
    }
  }

  /** Dernier échec de rangement, ou `null`. Publié : un échec toléré n'est pas un échec caché. */
  get dernierRangement() {
    return this.#rangement;
  }

  /**
   * Durée du plus long rangement de la session, en millisecondes. Publiée parce qu'un coût que
   * personne ne mesure finit par être supposé nul.
   */
  get dureeRangementMaxMs() {
    return this.#dureeRangementMaxMs;
  }

  /**
   * Fermeture exclusive. Elle rend le handle au support ET libère le nom : c'est le transfert de
   * propriété du volume, et c'est ce qui rend la réouverture possible dans la même session.
   * L'échec de la fermeture est remonté, jamais avalé — mais la propriété est relâchée d'abord,
   * pour qu'un support récalcitrant ne bloque pas définitivement le nom.
   */
  async close() {
    if (this.#acces.ferme) return;
    this.#acces.marquerFerme();
    libererVolume(this.#name);
    this.#journal.record(JOURNAL_OPERATIONS.close, { volume: this.#name });

    // Une fermeture PROPRE range la génération validée dans le volume : l'export (#11), la
    // restauration (#12) et la migration (#13) lisent le FICHIER, et doivent y trouver la génération
    // validée sans rien savoir du journal. Une génération non validée n'est PAS rangée — personne ne
    // l'a acquittée, et la prochaine ouverture l'écartera.
    let rangement = null;
    try {
      // Un rangement encore en vol doit finir avant la fermeture : l'abandonner en cours laisserait
      // le journal dans un état que la prochaine ouverture devrait rejouer sans raison.
      await this.#attendreRangement();
      if (this.#generation !== null && this.#generation.rangeable) {
        await this.#generation.pointDeControle();
      }
    } catch (cause) {
      rangement = toStorageError(cause, { operation: "checkpoint", volume: this.#name });
    }

    try {
      this.#generation?.close();
      this.#acces.fermer();
    } catch (cause) {
      throw rangement ?? toStorageError(cause, { operation: "close", volume: this.#name });
    }
    if (rangement !== null) throw rangement;
  }
}
