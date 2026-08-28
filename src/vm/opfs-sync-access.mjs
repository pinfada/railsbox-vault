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

/**
 * Suffixe RÉSERVÉ : il désigne le manifeste posé à côté d'un volume (#12). Un volume ne peut pas le
 * porter, sinon restaurer « donnees » détruirait un volume légitime nommé « donnees.manifest ».
 */
export const MANIFEST_SIDECAR_SUFFIX = ".manifest";

/**
 * Suffixe RÉSERVÉ du JOURNAL DE REPRISE d'une migration (#13). Il vit à côté du volume pour la même
 * raison que le manifeste : les octets du volume sont servis tels quels à v86, et y intercaler quoi
 * que ce soit décalerait le système de fichiers du guest.
 */
export const MIGRATION_JOURNAL_SUFFIX = ".migration";

/**
 * Suffixe RÉSERVÉ du JOURNAL DE GÉNÉRATION (#16). Il vit à côté du volume pour la même raison que
 * les deux précédents, et il est délibérément COURT : `MAX_VOLUME_NAME` se déduit du plus long
 * suffixe réservé, et un suffixe de plus de dix caractères aurait rétréci les noms de volume
 * admissibles — c'est-à-dire cassé la compatibilité de nommage pour un fichier interne.
 */
export const GENERATION_JOURNAL_SUFFIX = ".gen";

/**
 * Suffixe RÉSERVÉ du TÉMOIN DE SÉQUENCE (#19, ADR 0019).
 *
 * Il vit hors du fichier de volume — c'est toute sa raison d'être : un témoin logé dans le volume
 * reculerait avec lui — mais dans la MÊME ORIGINE, et l'ADR 0019 dit ce que cela vaut et ce que cela
 * ne vaut pas. Il est court, comme les trois précédents, pour ne pas rétrécir `MAX_VOLUME_NAME`.
 */
export const TEMOIN_SEQUENCE_SUFFIX = ".temoin";

/**
 * Suffixe RÉSERVÉ de l'ENVELOPPE DE CLÉ (#21, ADR 0020). Il vit à côté du volume pour la même raison
 * que les précédents, et il est plus court que `.migration` : `MAX_VOLUME_NAME` se déduit du plus
 * long suffixe réservé, et l'ajouter ne rétrécit donc AUCUN nom de volume déjà admissible.
 *
 * Ce fichier porte des clés de volume ENVELOPPÉES ; il ne vit que sur l'origine de CONFIANCE, avec
 * le volume et son manifeste (ADR 0002), et il n'entre jamais dans une archive d'export (ADR 0020,
 * décision 6).
 */
export const ENVELOPPE_SIDECAR_SUFFIX = ".cles";

/**
 * Tous les suffixes réservés aux voisins d'un volume. Aucun volume ne peut en porter un, sans quoi
 * migrer « donnees » détruirait un volume légitime nommé « donnees.migration ».
 */
export const RESERVED_SIDECAR_SUFFIXES = Object.freeze([
  MANIFEST_SIDECAR_SUFFIX,
  MIGRATION_JOURNAL_SUFFIX,
  GENERATION_JOURNAL_SUFFIX,
  TEMOIN_SEQUENCE_SUFFIX,
  ENVELOPPE_SIDECAR_SUFFIX,
]);

/** Longueur du plus long voisin à réserver : c'est elle qui borne le nom d'un volume. */
const LONGEST_SIDECAR_SUFFIX = Math.max(...RESERVED_SIDECAR_SUFFIXES.map((s) => s.length));

/**
 * Longueur maximale d'un NOM DE FICHIER dans le répertoire des volumes. C'est la vraie borne du
 * support ; elle doit accueillir le nom du manifeste voisin, pas seulement celui du volume.
 */
export const MAX_STORAGE_NAME = 64;

/**
 * Longueur maximale d'un NOM DE VOLUME : la borne du support, moins la place du PLUS LONG suffixe
 * réservé. Un volume plus long serait créable et exportable, puis IRRESTAURABLE — ou IMMIGRABLE —
 * faute de place pour son voisin, une impasse découverte trop tard. La frontière la refuse d'emblée.
 */
export const MAX_VOLUME_NAME = MAX_STORAGE_NAME - LONGEST_SIDECAR_SUFFIX;

/** Noms de fichier admis dans le répertoire des volumes : ni séparateur, ni remontée de chemin. */
const STORAGE_NAME = new RegExp(`^[a-z0-9][a-z0-9._-]{0,${MAX_STORAGE_NAME - 1}}$`);

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

/**
 * Valide un nom de FICHIER du répertoire des volumes : il devient un nom réel sur le support. Les
 * portes ci-dessous l'emploient parce qu'elles manipulent aussi bien un volume que son manifeste
 * voisin ; le nom de VOLUME, lui, est plus étroit — voir `assertVolumeName`.
 */
export function assertStorageName(name) {
  if (typeof name !== "string" || !STORAGE_NAME.test(name)) {
    throw new TypeError(
      `Nom de fichier de volume invalide : ${JSON.stringify(name)}. Attendu : ${STORAGE_NAME.source}`,
    );
  }
  return name;
}

/**
 * Valide un nom de VOLUME. En plus de la frontière de nommage, il refuse le suffixe réservé au
 * manifeste et laisse la place à celui-ci : deux impasses fermées à la création plutôt qu'à la
 * restauration.
 */
export function assertVolumeName(name) {
  assertStorageName(name);
  const reserve = RESERVED_SIDECAR_SUFFIXES.find((suffixe) => name.endsWith(suffixe));
  if (reserve !== undefined) {
    throw new TypeError(
      `Nom de volume invalide : ${JSON.stringify(name)}. Le suffixe « ${reserve} » est réservé à un voisin de volume.`,
    );
  }
  if (name.length > MAX_VOLUME_NAME) {
    throw new TypeError(
      `Nom de volume trop long : ${JSON.stringify(name)} (${name.length} > ${MAX_VOLUME_NAME}). Il doit rester de la place pour ses voisins.`,
    );
  }
  return name;
}

/**
 * Nom du manifeste posé À CÔTÉ d'un volume. Il vit dans le même répertoire et porte le suffixe
 * réservé ; comme `assertVolumeName` borne déjà la longueur du volume, le nom obtenu tient toujours
 * dans la frontière de nommage — un volume créable est toujours un volume restaurable.
 * @param {string} volume
 */
export function manifestSidecarName(volume) {
  assertVolumeName(volume);
  return `${volume}${MANIFEST_SIDECAR_SUFFIX}`;
}

/**
 * Nom du JOURNAL DE REPRISE d'une migration, posé à côté du volume (#13). Même règle de longueur :
 * un volume créable est toujours un volume migrable.
 * @param {string} volume
 */
export function migrationJournalName(volume) {
  assertVolumeName(volume);
  return `${volume}${MIGRATION_JOURNAL_SUFFIX}`;
}

/**
 * Nom du JOURNAL DE GÉNÉRATION posé à côté du volume (#16). Il n'est PAS dans le volume : les octets
 * du volume sont servis tels quels à v86, et y réserver une aire décalerait le système de fichiers
 * du guest — la même raison qui a exilé le manifeste (#10) et le journal de migration (#13).
 * @param {string} volume
 */
export function generationJournalName(volume) {
  assertVolumeName(volume);
  return `${volume}${GENERATION_JOURNAL_SUFFIX}`;
}

/**
 * Nom du TÉMOIN DE SÉQUENCE posé à côté du volume (#19). Même règle de longueur que ses voisins :
 * un volume créable est toujours un volume dont on peut dater la dernière séquence.
 * @param {string} volume
 */
export function temoinSequenceName(volume) {
  assertVolumeName(volume);
  return `${volume}${TEMOIN_SEQUENCE_SUFFIX}`;
}

/**
 * Nom de l'ENVELOPPE DE CLÉ posée à côté du volume (#21, ADR 0020). Même règle de longueur que les
 * autres voisins : un volume créable est toujours un volume déverrouillable.
 * @param {string} volume
 */
export function enveloppeSidecarName(volume) {
  assertVolumeName(volume);
  return `${volume}${ENVELOPPE_SIDECAR_SUFFIX}`;
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
  assertStorageName(name);

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
 * OBSERVE un volume sans le créer ni l'ouvrir en exclusivité. La restauration (#12) doit savoir si
 * une cible est déjà occupée AVANT de décider quoi que ce soit : ouvrir le handle exclusif pour le
 * découvrir créerait le fichier, c'est-à-dire muterait le support pour poser une question.
 *
 * @param {string} name
 * @returns {Promise<{ present: boolean, size: number }>}
 * @throws {StorageError} `VAULT_STORAGE_UNSUPPORTED` hors Worker ou sans OPFS.
 */
export async function statOpfsVolume(name) {
  assertDedicatedWorker();
  assertStorageName(name);

  try {
    // `create: false` jusqu'au bout : observer ne doit rien fabriquer, pas même le répertoire.
    const directory = await volumeDirectory({ create: false });
    const file = await directory.getFileHandle(name, { create: false });
    const { size } = await file.getFile();
    return { present: true, size };
  } catch (cause) {
    // Un volume absent — ou un répertoire qui n'existe pas encore — n'est pas un échec : c'est la
    // réponse « non ». Toute AUTRE cause est remontée typée : un support qui refuse de répondre ne
    // doit pas passer pour un support vide.
    if (cause?.name === "NotFoundError") return { present: false, size: 0 };
    throw toStorageError(cause, { operation: "stat", volume: name });
  }
}

/**
 * Ouvre un volume en LECTURE SEULE, sous la forme d'un `File` adossé au support. Aucun octet n'est
 * chargé en mémoire : le `File` est une vue paresseuse, que l'appelant lit par tranches (`slice`) ou
 * remet au navigateur pour un téléchargement. C'est ce qui permet d'extraire une archive de plusieurs
 * centaines de Mio sans jamais la tenir dans le tas.
 *
 * Contrairement à `openOpfsSyncAccess`, cette ouverture ne prend AUCUNE exclusivité et ne crée rien :
 * un volume absent est un refus typé, pas un fichier vide fabriqué pour l'occasion.
 *
 * @param {string} name
 * @returns {Promise<File>}
 */
export async function openOpfsVolumeFile(name) {
  assertDedicatedWorker();
  assertStorageName(name);

  try {
    const directory = await volumeDirectory({ create: false });
    const file = await directory.getFileHandle(name, { create: false });
    return await file.getFile();
  } catch (cause) {
    throw toStorageError(cause, { operation: "open-read-only", volume: name });
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
  assertStorageName(name);

  // Retirer un volume retire AUSSI son journal de génération (#16). Ce n'est pas une commodité : un
  // journal survivant décrirait un volume qui n'existe plus, et la prochaine ouverture d'un volume
  // du MÊME NOM y rejouerait une génération validée qui ne lui appartient pas — des octets d'un
  // volume précédent écrits par-dessus un volume neuf. La garde évite la récursion sur les voisins
  // eux-mêmes, qui n'ont pas de journal.
  //
  // Depuis #21, l'ENVELOPPE DE CLÉ part avec lui pour un motif symétrique et plus grave : une
  // enveloppe qui survit à son volume ne protège plus rien, et un volume neuf du MÊME NOM y
  // trouverait un fichier de clés qui nomme un autre identifiant de volume — refusé, mais
  // seulement après avoir donné à croire qu'une clé existait.
  const estUnVoisin = RESERVED_SIDECAR_SUFFIXES.some((suffixe) => name.endsWith(suffixe));
  if (!estUnVoisin) {
    await removeOpfsVolume(`${name}${GENERATION_JOURNAL_SUFFIX}`);
    // Et son TÉMOIN (#19). Un témoin survivant attesterait, pour un volume HOMONYME créé ensuite,
    // une séquence que celui-ci n'a jamais atteinte : la prochaine ouverture refuserait un volume
    // neuf et intact. C'est la même raison qui emporte déjà le journal de génération.
    await removeOpfsVolume(`${name}${TEMOIN_SEQUENCE_SUFFIX}`);
    await removeOpfsVolume(`${name}${ENVELOPPE_SIDECAR_SUFFIX}`);
  }

  try {
    const directory = await volumeDirectory({ create: false });
    await directory.removeEntry(name);
    return true;
  } catch (cause) {
    // Un volume absent n'est pas un échec de suppression : l'état visé est atteint. Toute AUTRE
    // cause est remontée typée — un handle encore ouvert, notamment, doit rester visible.
    if (cause?.name === "NotFoundError") return false;
    throw toStorageError(cause, { operation: "remove", volume: name });
  }
}
