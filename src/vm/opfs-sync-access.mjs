// Ouverture d'un `FileSystemSyncAccessHandle` sur le système de fichiers d'origine privée.
//
// C'est l'unique porte du dépôt vers OPFS, et elle est fermée à clé pour tout ce qui n'est pas un
// Worker dédié. L'ADR 0002 pose que la VM et le document applicatif n'obtiennent JAMAIS d'accès
// direct au stockage de la coquille ; `createSyncAccessHandle` n'est de toute façon exposé qu'aux
// Workers dédiés par les moteurs, mais s'appuyer sur cette coïncidence serait fragile. La garde
// ci-dessous rend la règle vérifiable : la sonde de page de
// `tests/browser/opfs-block-backend.spec.mjs` exige de recevoir `VAULT_STORAGE_UNSUPPORTED`.
//
// Aucune capacité manquante n'est remplacée par un repli. Un moteur sans OPFS synchrone ne peut pas
// porter `VAULT-PERSIST-001` : il faut le dire, pas le contourner.

import { toStorageError } from "./opfs-error-mapping.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/** Répertoire OPFS où vivent les volumes. Isolé pour ne pas heurter d'autres usages du stockage. */
export const VOLUME_DIRECTORY = "vault-volumes";

/** Noms de volume admis : pas de séparateur, pas de remontée de chemin, longueur bornée. */
const VOLUME_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function unsupported(message, context) {
  return new StorageError(STORAGE_ERROR_CODES.unsupported, message, context);
}

/** Refuse tout contexte qui n'est pas un Worker dédié. */
function assertDedicatedWorker() {
  const scope = globalThis.WorkerGlobalScope;
  if (typeof scope !== "function" || !(globalThis instanceof scope)) {
    throw unsupported(
      "Un handle OPFS exclusif ne s'ouvre que depuis un Worker dédié (ADR 0002) : ni la page, ni la VM ne l'obtiennent.",
      { context: "hors-worker" },
    );
  }
}

/** Valide le nom à la frontière : il devient un nom de fichier réel. */
export function assertVolumeName(name) {
  if (typeof name !== "string" || !VOLUME_NAME.test(name)) {
    throw new TypeError(
      `Nom de volume invalide : ${JSON.stringify(name)}. Attendu : ${VOLUME_NAME.source}`,
    );
  }
  return name;
}

async function volumeDirectory({ create }) {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== "function") {
    throw unsupported(
      "navigator.storage.getDirectory est absent de ce moteur : OPFS n'est pas disponible.",
      { capability: "navigator.storage.getDirectory" },
    );
  }
  const root = await storage.getDirectory();
  return root.getDirectoryHandle(VOLUME_DIRECTORY, { create });
}

/**
 * Ouvre le handle exclusif d'un volume, en le créant s'il n'existe pas.
 *
 * @param {string} name
 * @returns {Promise<FileSystemSyncAccessHandle>}
 * @throws {StorageError} `VAULT_STORAGE_UNSUPPORTED` hors Worker ou sans OPFS,
 *   `VAULT_STORAGE_BUSY` si un autre détenteur tient déjà le fichier.
 */
export async function openOpfsSyncAccess(name) {
  assertDedicatedWorker();
  assertVolumeName(name);

  let file;
  try {
    const directory = await volumeDirectory({ create: true });
    file = await directory.getFileHandle(name, { create: true });
  } catch (cause) {
    throw toStorageError(cause, { operation: "open-file", volume: name });
  }

  if (typeof file.createSyncAccessHandle !== "function") {
    throw unsupported(
      "FileSystemFileHandle.createSyncAccessHandle est absent de ce moteur : le volume ne peut pas être ouvert en accès synchrone.",
      { capability: "createSyncAccessHandle", volume: name },
    );
  }

  try {
    return await file.createSyncAccessHandle();
  } catch (cause) {
    throw toStorageError(cause, { operation: "create-sync-access-handle", volume: name });
  }
}

/**
 * Supprime un volume. Réservé à l'hygiène des tests et aux migrations explicites : le produit ne
 * détruit jamais un volume sans geste de l'utilisateur.
 * @param {string} name
 * @returns {Promise<boolean>} vrai si un fichier a été supprimé
 */
export async function removeOpfsVolume(name) {
  assertDedicatedWorker();
  assertVolumeName(name);

  try {
    const directory = await volumeDirectory({ create: true });
    await directory.removeEntry(name);
    return true;
  } catch (cause) {
    // Un volume absent n'est pas un échec de suppression : l'état visé est atteint. Toute AUTRE
    // cause est remontée typée — un handle encore ouvert, notamment, doit rester visible.
    if (cause?.name === "NotFoundError") return false;
    throw toStorageError(cause, { operation: "remove", volume: name });
  }
}
