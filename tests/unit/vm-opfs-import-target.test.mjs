import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { MANIFEST_ERROR_CODES, ManifestError } from "../../src/vm/manifest-errors.mjs";
import { createOpfsImportTarget } from "../../src/vm/opfs-import-target.mjs";
import { STORAGE_ERROR_CODES, StorageError, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";

// Preuve unitaire de la CIBLE OPFS de la restauration (#12).
//
// Elle porte sur un point précis : ce que `inspect()` fait d'un voisin qu'elle n'arrive pas à lire.
// Un voisin trop grand pour le budget de surmémoire est un fait de FORMAT — il n'est pas un
// manifeste, la restauration doit refuser sans rien détruire. Un support occupé, absent ou perdu est
// un fait de SUPPORT : le convertir en « voisin illisible » ferait remonter
// `VAULT_IMPORT_TARGET_NOT_EMPTY` là où l'exploitant doit lire `VAULT_STORAGE_BUSY`. Le refus serait
// sûr, mais il nommerait la mauvaise cause — et une cause mal nommée envoie vers le mauvais remède.

const TAILLE = 8 * SECTOR_SIZE;

function manifesteValide() {
  return createManifest({
    runtime: { version: "0.1.0", artifact: null },
    app: { id: "railsbox-vault-reference", version: "1.0.0" },
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
  });
}

test("un voisin lisible est rendu tel quel à l'orchestration", async () => {
  const octets = serializeManifest(manifesteValide());
  const cible = createOpfsImportTarget("vault-app", {
    stat: () => Promise.resolve({ present: true, size: TAILLE }),
    readManifest: () => Promise.resolve(octets),
  });

  const etat = await cible.inspect();
  assert.equal(etat.present, true);
  assert.equal(etat.size, TAILLE);
  assert.deepEqual(etat.manifestBytes, octets);
});

test("un voisin démesuré devient un fait observé : présent, non analysable, jamais supprimé", async () => {
  const cible = createOpfsImportTarget("vault-app", {
    stat: () => Promise.resolve({ present: true, size: TAILLE }),
    readManifest: () =>
      Promise.reject(
        new ManifestError(MANIFEST_ERROR_CODES.malformed, "Voisin au-delà du plafond de lecture."),
      ),
  });

  const etat = await cible.inspect();
  // Ni `null` (« pas de voisin »), ni un manifeste : l'orchestration refusera par `parseManifest`.
  assert.notEqual(etat.manifestBytes, null);
  assert.ok(etat.manifestBytes instanceof Uint8Array);
});

test("un échec de SUPPORT est propagé typé, jamais déguisé en voisin illisible", async () => {
  const cible = createOpfsImportTarget("vault-app", {
    stat: () => Promise.resolve({ present: true, size: TAILLE }),
    readManifest: () =>
      Promise.reject(
        new StorageError(
          STORAGE_ERROR_CODES.busy,
          "Le volume est déjà ouvert en exclusivité dans un autre onglet.",
        ),
      ),
  });

  await assert.rejects(
    () => cible.inspect(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );
});

test("un support absent de ce moteur est propagé, pas transformé en cible occupée", async () => {
  const cible = createOpfsImportTarget("vault-app", {
    stat: () =>
      Promise.reject(
        new StorageError(STORAGE_ERROR_CODES.unsupported, "OPFS n'est pas disponible ici."),
      ),
    readManifest: () => Promise.resolve(null),
  });

  await assert.rejects(
    () => cible.inspect(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.unsupported),
  );
});
