// Journal d'E/S du backend de blocs. Le spike #4 doit prouver un ORDRE — écriture, puis barrière,
// puis acquittement — et non un simple total d'appels. Le journal est donc une suite ordonnée
// d'entrées gelées, horodatées sur une horloge monotone injectable pour rester testable sous Node.

/** Opérations journalisées. `ata` provient du pont de durabilité, pas du backend. */
export const JOURNAL_OPERATIONS = Object.freeze({
  read: "read",
  write: "write",
  flush: "flush",
  flushAck: "flush-ack",
  close: "close",
  fault: "fault",
  failure: "failure",
  ata: "ata",
  mark: "mark",
});

const KNOWN_OPERATIONS = new Set(Object.values(JOURNAL_OPERATIONS));

/** Champs posés par le journal lui-même : un détail homonyme masquerait l'entrée. */
const RESERVED_FIELDS = Object.freeze(["seq", "at", "operation"]);

const DEFAULT_LIMIT = 200000;

export class BlockJournal {
  #entries = [];
  #clock;
  #limit;
  #sequence = 0;

  /**
   * @param {{ clock?: () => number, limit?: number }} [options]
   *   `clock` doit être monotone ; `performance.now` par défaut, injectable pour les tests.
   */
  constructor({ clock = () => performance.now(), limit = DEFAULT_LIMIT } = {}) {
    if (typeof clock !== "function") throw new TypeError("Le journal exige une horloge appelable.");
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("La limite du journal doit être un entier positif.");
    }
    this.#clock = clock;
    this.#limit = limit;
  }

  /**
   * Ajoute une entrée. Le débordement est une ERREUR : un journal qui oublie silencieusement ses
   * premières entrées invaliderait toute preuve d'ordre.
   * @param {string} operation une valeur de `JOURNAL_OPERATIONS`
   * @param {Record<string, unknown>} [details]
   */
  record(operation, details = {}) {
    if (!KNOWN_OPERATIONS.has(operation)) {
      throw new Error(`Opération journalisée inconnue : ${operation}`);
    }
    const collision = RESERVED_FIELDS.find((field) => Object.hasOwn(details, field));
    if (collision) {
      throw new Error(
        `Le détail « ${collision} » masquerait un champ du journal : renommer l'appelant.`,
      );
    }
    if (this.#entries.length >= this.#limit) {
      throw new RangeError(
        `Journal saturé à ${this.#limit} entrées : la mesure serait tronquée sans le dire.`,
      );
    }
    const entry = Object.freeze({
      seq: this.#sequence++,
      at: this.#clock(),
      operation,
      ...details,
    });
    this.#entries.push(entry);
    return entry;
  }

  /** Copie immuable du journal. */
  entries() {
    return Object.freeze([...this.#entries]);
  }

  get length() {
    return this.#entries.length;
  }

  /** Nombre d'entrées par opération. */
  counts() {
    const counts = {};
    for (const entry of this.#entries) {
      counts[entry.operation] = (counts[entry.operation] ?? 0) + 1;
    }
    return counts;
  }

  /** Entrées d'une opération donnée, dans l'ordre. */
  select(operation) {
    return this.#entries.filter((entry) => entry.operation === operation);
  }

  /** Numéro de séquence de la dernière entrée d'une opération, ou `-1`. */
  lastSequenceOf(operation) {
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      if (this.#entries[index].operation === operation) return this.#entries[index].seq;
    }
    return -1;
  }
}

/**
 * Parcourt le journal une seule fois et APPARIE chaque `flush` à son acquittement, en comptant au
 * passage les écritures qui le précèdent et celles qui se glissent entre lui et son acquittement.
 *
 * Ce relevé ne juge de rien : il rend ce qu'il a vu, y compris l'acquittement orphelin qui a
 * interrompu le parcours. Le verdict est calculé à part, pour que l'ordre des contrôles soit lisible
 * d'un bloc au lieu d'être dispersé dans la boucle.
 *
 * @param {readonly object[]} entries
 * @returns {{ barriers: object[], pending: Map<unknown, object>, orphelin: object | null }}
 */
function apparierBarrieres(entries) {
  const barriers = [];
  let writesBefore = 0;
  const pending = new Map();

  for (const entry of entries) {
    if (entry.operation === JOURNAL_OPERATIONS.write) {
      writesBefore += 1;
      for (const barrier of pending.values()) barrier.writesBetween += 1;
    } else if (entry.operation === JOURNAL_OPERATIONS.flush) {
      pending.set(entry.barrier, {
        flushSeq: entry.seq,
        ackSeq: -1,
        writesBefore,
        writesBetween: 0,
      });
    } else if (entry.operation === JOURNAL_OPERATIONS.flushAck) {
      const barrier = pending.get(entry.barrier);
      // Le parcours s'ARRÊTE ici : la suite du journal se lirait sur un appariement déjà faux.
      if (!barrier) return { barriers, pending, orphelin: entry };
      barrier.ackSeq = entry.seq;
      pending.delete(entry.barrier);
      barriers.push(barrier);
    }
  }
  return { barriers, pending, orphelin: null };
}

/**
 * Juge le relevé. L'ORDRE de ces contrôles fait partie du contrat : un journal fautif sur plusieurs
 * points doit toujours rendre la MÊME raison, sinon deux exécutions du même scénario se
 * raconteraient différemment. Chaque défaut rend aussi les barrières déjà appariées : un verdict
 * négatif sans son relevé n'apprendrait rien à qui l'enquête.
 *
 * @param {{ barriers: object[], pending: Map<unknown, object>, orphelin: object | null }} releve
 */
function verdictDesBarrieres({ barriers, pending, orphelin }) {
  if (orphelin) {
    return {
      satisfied: false,
      barriers,
      reason: `Acquittement sans barrière correspondante (barrier=${orphelin.barrier}).`,
    };
  }
  if (pending.size > 0) {
    return {
      satisfied: false,
      barriers,
      reason: `${pending.size} barrière(s) jamais acquittée(s).`,
    };
  }
  if (barriers.length === 0) {
    return { satisfied: false, barriers, reason: "Aucune barrière de durabilité observée." };
  }
  const unordered = barriers.find((barrier) => barrier.ackSeq < barrier.flushSeq);
  if (unordered) {
    return {
      satisfied: false,
      barriers,
      reason: `Acquittement antérieur à sa barrière (flush=${unordered.flushSeq}).`,
    };
  }
  const empty = barriers.find((barrier) => barrier.writesBefore === 0);
  if (empty) {
    return {
      satisfied: false,
      barriers,
      reason: `Barrière ${empty.flushSeq} émise sans aucune écriture préalable.`,
    };
  }
  return { satisfied: true, barriers, reason: null };
}

/**
 * Vérifie la promesse de durabilité : chaque `flush` acquitté est précédé d'au moins une écriture,
 * et son acquittement suit toutes les écritures émises avant lui.
 *
 * C'est la propriété que `docs/quality-attributes.md` appelle « RPO 0 après la barrière durable du
 * guest ». Elle se lit sur l'ordre du journal, pas sur des totaux.
 *
 * @param {readonly object[]} entries sortie de `BlockJournal#entries()`
 * @returns {{ satisfied: boolean, barriers: Array<{ flushSeq: number, ackSeq: number,
 *             writesBefore: number, writesBetween: number }>, reason: string | null }}
 */
export function auditDurabilityBarriers(entries) {
  return verdictDesBarrieres(apparierBarrieres(entries));
}
