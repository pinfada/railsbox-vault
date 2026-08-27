// REGISTRE des volumes OPFS ouverts dans ce contexte (#6, `VAULT-PERSIST-001`).
//
// OPFS refuse déjà un second `FileSystemSyncAccessHandle` exclusif sur le même fichier. Le registre
// ne remplace pas ce refus : il le rend IMMÉDIAT et NOMMÉ — `VAULT_STORAGE_BUSY` avec le nom du
// volume — avant d'aller déranger le support, et il ne dit jamais autre chose que ce que le support
// dirait.
//
// Il vit dans son propre module parce qu'il est le seul état partagé entre l'OUVERTURE, qui réserve
// un nom, et le BACKEND, qui le relâche en se fermant. Les réunir ferait de ces deux modules un
// cycle d'imports.

import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/** Nom de volume → backend qui le détient. */
const ouverts = new Map();

/**
 * Refuse tout de suite si le nom est déjà détenu dans ce contexte.
 *
 * @param {string} name nom du volume
 */
export function assertVolumeLibre(name) {
  if (!ouverts.has(name)) return;
  throw new StorageError(
    STORAGE_ERROR_CODES.busy,
    `Le volume « ${name} » est déjà ouvert en exclusivité dans ce contexte.`,
    { volume: name },
  );
}

/** Inscrit le détenteur d'un nom. Appelé une fois le volume réellement ouvert. */
export function reserverVolume(name, backend) {
  ouverts.set(name, backend);
}

/** Relâche le nom. C'est le transfert de propriété qui rend la réouverture possible. */
export function libererVolume(name) {
  ouverts.delete(name);
}
