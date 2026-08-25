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

// --- Valeurs de RETOUR d'une écriture ou d'une lecture (#73) -------------------------------------
//
// Les deux fonctions ci-dessous ne traduisent pas une EXCEPTION mais une VALEUR DE RETOUR. Elles
// existent parce que le job « Reprise MVP » a observé, sur les exécutants GitHub et jamais en local,
// un `FileSystemSyncAccessHandle.write()` qui rend **4294967288** pour 4194304 octets demandés.
//
// 4294967288 = 2^32 − 8 : l'entier signé −8 lu comme non signé sur 32 bits. Chromium implémente ces
// handles au-dessus de `base::File`, dont les échecs sont les valeurs NÉGATIVES de l'énumération
// `base::File::Error` (`base/files/file.h`), où `-8` est `FILE_ERROR_NO_SPACE`. La spécification,
// elle, n'admet aucune valeur de retour supérieure à la longueur demandée : `write()` doit LEVER
// (`QuotaExceededError`, `InvalidStateError`…) plutôt que rendre un code.
//
// Le dépôt ne peut pas corriger le moteur. Il peut refuser d'en tirer une phrase fausse : dire
// « 4294967288 octets écrits sur 4194304 » n'est pas décrire une écriture courte, c'est présenter un
// ÉCHEC comme un compte. Trois lectures possibles, trois états distincts :
//
//   rendu == demandé      → succès ;
//   0 ≤ rendu < demandé   → écriture réellement partielle / lecture réellement courte ;
//   rendu > demandé       → ce n'est pas un compte. Décodé en entier signé 32 bits, nommé quand la
//                           table le connaît, et classé — `NO_SPACE` en quota épuisé, tout le reste
//                           en échec de support NON classé, jamais deviné.

/** Étendue des entiers non signés sur 32 bits : le cast qui produit 4294967288. */
const UINT32_SPAN = 2 ** 32;

/**
 * Noms de `base::File::Error` (Chromium, `base/files/file.h`). Ils ne servent QU'À NOMMER une valeur
 * observée : aucun comportement du dépôt ne dépend de la table au-delà de `FILE_ERROR_NO_SPACE`.
 * Une valeur absente reste un échec, avec son errno brut et sans nom inventé.
 *
 * @see https://source.chromium.org/chromium/chromium/src/+/main:base/files/file.h
 */
export const CHROMIUM_FILE_ERRORS = new Map([
  [-1, "FILE_ERROR_FAILED"],
  [-2, "FILE_ERROR_IN_USE"],
  [-3, "FILE_ERROR_EXISTS"],
  [-4, "FILE_ERROR_NOT_FOUND"],
  [-5, "FILE_ERROR_ACCESS_DENIED"],
  [-6, "FILE_ERROR_TOO_MANY_OPENED"],
  [-7, "FILE_ERROR_NO_MEMORY"],
  [-8, "FILE_ERROR_NO_SPACE"],
  [-9, "FILE_ERROR_NOT_A_DIRECTORY"],
  [-10, "FILE_ERROR_INVALID_OPERATION"],
  [-11, "FILE_ERROR_SECURITY"],
  [-12, "FILE_ERROR_ABORT"],
  [-13, "FILE_ERROR_NOT_A_FILE"],
  [-14, "FILE_ERROR_NOT_EMPTY"],
  [-15, "FILE_ERROR_INVALID_URL"],
  [-16, "FILE_ERROR_IO"],
  [-17, "FILE_ERROR_MAX"],
]);

/** Le seul errno que le dépôt CLASSE : plus de place est un état contractuel distinct. */
const ERRNO_NO_SPACE = -8;

/**
 * Interprète la valeur rendue par un `read`/`write` de `FileSystemSyncAccessHandle`.
 *
 * @param {unknown} returned valeur rendue par le support
 * @param {number} requested longueur demandée
 * @returns {{ kind: "exact"|"court"|"errno", errno: number|null, name: string|null }}
 */
export function decodeSupportCount(returned, requested) {
  if (returned === requested) return { kind: "exact", errno: null, name: null };
  if (Number.isInteger(returned) && returned >= 0 && returned < requested) {
    return { kind: "court", errno: null, name: null };
  }

  // Tout le reste — au-dessus de la demande, négatif, ou non entier — n'est pas un compte d'octets.
  // Le cas OBSERVÉ est le cast non signé d'un entier négatif sur 32 bits ; on le défait, mais SEULEMENT
  // dans la plage où ce cast a un sens.
  const cast =
    Number.isInteger(returned) && returned >= 2 ** 31 && returned < UINT32_SPAN
      ? returned - UINT32_SPAN
      : returned;

  // Un errno est un entier NÉGATIF, casté ou rendu tel quel. Une valeur positive qui dépasse la
  // demande — 2^32 et au-delà, par exemple — ne se décode en rien : la rendre sous l'étiquette
  // « errno » inventerait un diagnostic, et c'est précisément ce que ce module refuse de faire.
  // Elle reste un échec, dit comme une valeur non interprétée.
  if (!Number.isInteger(cast) || cast >= 0) {
    return { kind: "errno", errno: null, name: null };
  }
  return { kind: "errno", errno: cast, name: CHROMIUM_FILE_ERRORS.get(cast) ?? null };
}

/**
 * Phrase qui NOMME ce qui a été observé, sans jamais parler d'octets écrits ou lus.
 *
 * Trois degrés de certitude, et la phrase ne va jamais au-delà du sien : un errno connu de la table
 * est nommé ; un errno hors table est donné brut ; une valeur qui ne se décode même pas en entier
 * est signalée comme telle plutôt que présentée comme « l'errno null ».
 */
function phraseErrno({ returned, errno, name, operation, volume, offset }) {
  const decodage =
    errno === null
      ? `${JSON.stringify(returned) ?? String(returned)} n'est pas un nombre d'octets`
      : `${returned} se décode en ${name === null ? `l'errno ${errno}` : `${name} (${errno})`}`;
  return (
    `Le support OPFS a rendu un code d'échec au lieu d'un nombre d'octets pour « ${operation} » ` +
    `sur « ${volume} » à l'offset ${offset} : ${decodage}. ` +
    `Aucun octet ne peut être tenu pour traité.`
  );
}

/** Contexte commun d'un retour errno : de quoi trancher sans relire les journaux du moteur. */
function contexteErrno({ operation, volume, offset, requested, returned, errno, name, storage }) {
  return {
    operation,
    volume,
    offset,
    requested,
    returned,
    errno,
    errnoName: name,
    // `null` DIT que la mesure n'a pas été prise ; il ne prétend pas que le moteur ignore son quota.
    // L'appelant qui peut mesurer (`navigator.storage.estimate()`) la fournit.
    storage: storage ?? null,
  };
}

/**
 * Erreur typée d'une valeur de retour de `write()`, ou `null` si l'écriture est complète.
 *
 * @param {number} returned valeur rendue par `FileSystemSyncAccessHandle.write()`
 * @param {{ requested: number, volume: string, offset: number, operation?: string,
 *           storage?: { state: string, quota: number|null, usage: number|null,
 *                       available: number|null } | null }} contexte
 * @returns {StorageError|null}
 */
export function writeCountFailure(
  returned,
  { requested, volume, offset, operation = "write", storage = null },
) {
  const { kind, errno, name } = decodeSupportCount(returned, requested);
  if (kind === "exact") return null;

  if (kind === "court") {
    return new StorageError(
      STORAGE_ERROR_CODES.partialWrite,
      `Écriture partielle : ${returned} octet(s) acceptés sur ${requested} à l'offset ${offset} du volume « ${volume} ».`,
      { volume, offset, requested, accepted: returned },
    );
  }

  // Plus de place est un état contractuel à part : il a son remède (libérer de l'espace) et sa
  // conduite produit (#9). Tout autre errno reste NON classé — le nommer suffit, le ranger mentirait.
  const code =
    errno === ERRNO_NO_SPACE
      ? STORAGE_ERROR_CODES.quotaExceeded
      : STORAGE_ERROR_CODES.supportFailure;
  return new StorageError(
    code,
    phraseErrno({ returned, errno, name, operation, volume, offset }),
    contexteErrno({ operation, volume, offset, requested, returned, errno, name, storage }),
  );
}

/**
 * Erreur typée d'une valeur de retour de `read()`, ou `null` si la lecture est exacte.
 *
 * Une lecture qui rend un errno n'est JAMAIS classée en manque de place : lire ne réclame pas
 * d'espace. Elle reste un échec de support non classé, quel que soit l'errno.
 *
 * @returns {StorageError|null}
 */
export function readCountFailure(
  returned,
  { requested, volume, offset, operation = "read", storage = null },
) {
  const { kind, errno, name } = decodeSupportCount(returned, requested);
  if (kind === "exact") return null;

  if (kind === "court") {
    return new StorageError(
      STORAGE_ERROR_CODES.shortRead,
      `Lecture courte : ${returned} octet(s) rendus sur ${requested} demandés à l'offset ${offset} du volume « ${volume} ».`,
      { volume, offset, requested, obtained: returned },
    );
  }

  return new StorageError(
    STORAGE_ERROR_CODES.supportFailure,
    phraseErrno({ returned, errno, name, operation, volume, offset }),
    contexteErrno({ operation, volume, offset, requested, returned, errno, name, storage }),
  );
}
