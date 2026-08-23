// Erreurs contractuelles du backend de blocs. `docs/architecture.md` exige que quota, handle perdu,
// écriture partielle et échec de flush restent des états DISTINCTS : aucun d'eux ne doit se
// dégrader en succès, en bloc de zéros ou en réinitialisation silencieuse. Les codes ci-dessous
// sont la première proposition stable ; l'issue #6 les figera pour le backend de production.

export const STORAGE_ERROR_CODES = Object.freeze({
  /** Lecture ou écriture hors de la géométrie déclarée. */
  outOfRange: "VAULT_STORAGE_OUT_OF_RANGE",
  /** Le support a rendu moins d'octets que demandé. */
  shortRead: "VAULT_STORAGE_SHORT_READ",
  /** Le support a accepté moins d'octets que demandé. */
  partialWrite: "VAULT_STORAGE_PARTIAL_WRITE",
  /** La barrière de durabilité n'a pas abouti. */
  flushFailed: "VAULT_STORAGE_FLUSH_FAILED",
  /** Le handle exclusif a disparu sous le volume ouvert. */
  handleLost: "VAULT_STORAGE_HANDLE_LOST",
  /** Opération demandée après fermeture du volume. */
  closed: "VAULT_STORAGE_CLOSED",
  /** Un autre détenteur possède déjà l'exclusivité du volume. */
  busy: "VAULT_STORAGE_BUSY",
  /** Capacité absente : jamais remplacée par un repli silencieux. */
  unsupported: "VAULT_STORAGE_UNSUPPORTED",
});

const KNOWN_CODES = new Set(Object.values(STORAGE_ERROR_CODES));

/** Erreur typée du stockage : un code stable, un message français, un contexte sérialisable. */
export class StorageError extends Error {
  /**
   * @param {string} code une valeur de `STORAGE_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur de stockage inconnu : ${code}`);
    }
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur de stockage portant `code`. */
export function isStorageError(value, code) {
  return value instanceof StorageError && (code === undefined || value.code === code);
}

export function outOfRange(offset, length, size) {
  return new StorageError(
    STORAGE_ERROR_CODES.outOfRange,
    `Accès hors bornes : ${length} octet(s) à l'offset ${offset} d'un volume de ${size} octets.`,
    { offset, length, size },
  );
}
