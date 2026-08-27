// OUVERTURE d'un volume OPFS, et RÉCUPÉRATION de sa dernière génération (#6, #16, ADR 0014).
//
// C'est le seul chemin admis vers un `OpfsBlockBackend` : le constructeur ne garantit ni géométrie
// ni exclusivité, et l'ouverture est précisément la suite de gestes qui les établit — réserver le
// nom, saisir le handle, confronter la géométrie déclarée à celle du fichier, allouer si le volume
// naît, puis ouvrir le journal voisin et récupérer.
//
// La règle qui traverse tout le module : **chaque refus survenant APRÈS l'ouverture rend ce qu'il a
// pris.** Un handle non rendu laisserait le fichier verrouillé par un volume que personne ne
// détient, et le nom occupé par un backend que personne ne peut fermer.

import { SECTOR_SIZE, assertBlockGeometry, isBlockGeometry } from "./block-geometry.mjs";
import { BlockJournal } from "./block-journal.mjs";
import { createFaultPlan } from "./fault-plan.mjs";
import { GenerationStore } from "./generation-store.mjs";
import { OpfsBlockBackend } from "./opfs-block-backend.mjs";
import { toStorageError } from "./opfs-error-mapping.mjs";
import { generationJournalName, openOpfsSyncAccess } from "./opfs-sync-access.mjs";
import { assertVolumeLibre, reserverVolume } from "./opfs-volume-registry.mjs";
import { STORAGE_ERROR_CODES, StorageError, geometryMismatch } from "./storage-errors.mjs";

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
 * SAISIT le support : handle exclusif, géométrie relue puis confrontée à celle qui est déclarée,
 * allocation si le volume naît. L'ouvreur peut être le vrai OPFS, qui rend déjà des erreurs typées,
 * ou un double qui rend des `DOMException` brutes : les deux passent par la même traduction. Chaque
 * refus survenant APRÈS l'ouverture rend le handle, sans quoi le fichier resterait verrouillé par
 * un volume que personne ne détient.
 */
async function saisirSupport({ name, size, openHandle }) {
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

  return { handle, geometry };
}

/**
 * Installe le magasin de générations sur un backend déjà construit, ou REFERME ce backend : un
 * refus de génération ne doit pas laisser le nom occupé par un volume que personne ne détient.
 */
async function installerGenerationOuFermer(
  backend,
  { name, size, openHandle, seuilPointDeControle },
) {
  try {
    backend.installerGeneration(
      await ouvrirGeneration({ name, size, backend, openHandle, seuilPointDeControle }),
    );
  } catch (cause) {
    await backend.close().catch(() => {});
    throw cause;
  }
}

/**
 * Ouvre le journal de génération voisin et RÉCUPÈRE. C'est ici que se joue la promesse de #16 : au
 * retour, le volume porte la dernière génération VALIDÉE, et rien d'autre.
 */
async function ouvrirGeneration({ name, size, backend, openHandle, seuilPointDeControle }) {
  const nomJournal = generationJournalName(name);
  let handle;
  try {
    handle = await openHandle(nomJournal);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open-generation", volume: name });
  }
  try {
    return await ouvrirMagasin({ name, size, backend, handle, seuilPointDeControle });
  } catch (cause) {
    try {
      handle.close();
    } catch {
      // La fermeture de secours ne doit jamais masquer la raison du refus.
    }
    throw cause;
  }
}

async function ouvrirMagasin({ name, size, backend, handle, seuilPointDeControle }) {
  try {
    return await GenerationStore.ouvrir({
      volume: name,
      handle,
      tailleVolume: size,
      lireVolume: (offset, longueur) => backend.lireSupportBrut(offset, longueur),
      ecrireVolume: (offset, octets) => backend.ecrireSupportBrut(offset, octets),
      barriereVolume: () => backend.barriereSupportBrute(),
      seuilPointDeControle,
    });
  } catch (cause) {
    // Un échec du SUPPORT pendant la récupération — quota, handle perdu — reste un état contractuel
    // nommé. Les refus propres au journal (`VAULT_STORAGE_GENERATION_*`) traversent tels quels.
    throw toStorageError(cause, { operation: "recover-generation", volume: name });
  }
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
  seuilPointDeControle,
} = {}) {
  assertVolumeLibre(name);
  if (size !== undefined) assertBlockGeometry(size);

  const { handle, geometry } = await saisirSupport({ name, size, openHandle });

  const backend = new OpfsBlockBackend({
    name,
    handle,
    size: geometry.size,
    journal,
    faults,
    flushDelay,
  });

  if (transactionnel) {
    await installerGenerationOuFermer(backend, {
      name,
      size: geometry.size,
      openHandle,
      seuilPointDeControle,
    });
  }

  reserverVolume(name, backend);
  return backend;
}
