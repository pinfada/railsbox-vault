// Traduction des échecs du système de fichiers d'origine privée en erreurs contractuelles de
// Vault. C'est le point où une panne de support cesse d'être un `DOMException` anonyme pour
// devenir un état nommé de `docs/architecture.md`.
//
// Deux règles gouvernent cette table :
//
//  - un nom connu est traduit par son état exact — le quota n'est pas une écriture partielle, une
//    exclusivité refusée n'est pas un handle perdu ;
//  - un nom INCONNU n'est jamais rangé dans l'état le plus proche. Il devient
//    `VAULT_STORAGE_SUPPORT_FAILURE`, qui dit exactement ce que l'on sait : le support a échoué, et
//    la cause n'est pas classée. Deviner ici reviendrait à inventer un diagnostic.

import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/**
 * Noms de `DOMException` que le contrat OPFS peut produire, et leur état Vault.
 * Une `Map` plutôt qu'un objet littéral : un nom d'exception est une donnée extérieure, et un objet
 * répondrait `function` à une clé comme `toString`.
 */
const SUPPORT_FAILURES = new Map([
  // `navigator.storage` a refusé l'allocation : le disque de l'utilisateur ou le quota d'origine.
  ["QuotaExceededError", STORAGE_ERROR_CODES.quotaExceeded],
  // Un autre `FileSystemSyncAccessHandle` détient déjà le fichier.
  ["NoModificationAllowedError", STORAGE_ERROR_CODES.busy],
  // Le handle a été fermé, ou son fichier a disparu sous lui.
  ["InvalidStateError", STORAGE_ERROR_CODES.handleLost],
  ["NotFoundError", STORAGE_ERROR_CODES.handleLost],
  ["NotReadableError", STORAGE_ERROR_CODES.handleLost],
  ["AbortError", STORAGE_ERROR_CODES.handleLost],
  // Le contexte n'a pas le droit d'ouvrir OPFS : capacité absente, jamais un repli.
  ["SecurityError", STORAGE_ERROR_CODES.unsupported],
  ["TypeMismatchError", STORAGE_ERROR_CODES.unsupported],
]);

/** Les noms traduits, pour la documentation et les tests de contrat. */
export const MAPPED_SUPPORT_FAILURES = Object.freeze([...SUPPORT_FAILURES.keys()]);

/**
 * @param {unknown} cause erreur brute rendue par OPFS
 * @param {{ operation: string, volume: string, offset?: number, length?: number }} context
 * @returns {StorageError} toujours typée, jamais l'erreur brute
 */
export function toStorageError(cause, context) {
  if (cause instanceof StorageError) return cause;

  const name = typeof cause?.name === "string" ? cause.name : "Error";
  const code = SUPPORT_FAILURES.get(name) ?? STORAGE_ERROR_CODES.supportFailure;
  const detail = typeof cause?.message === "string" && cause.message ? ` — ${cause.message}` : "";

  return new StorageError(
    code,
    `Le support OPFS a refusé l'opération « ${context.operation} » sur le volume « ${context.volume} » : ${name}${detail}`,
    { ...context, cause: name },
  );
}
