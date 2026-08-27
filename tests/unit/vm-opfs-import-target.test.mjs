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
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
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

// Un JOURNAL DE MIGRATION périmé ne doit pas survivre à la restauration du volume (#13). Sans ce
// retrait, un volume restauré depuis une archive garderait à côté de lui le journal d'une migration
// interrompue portant sur un contenu qui n'existe plus — et ce journal, faisant autorité sur le
// format de départ, rendrait le volume non migrable jusqu'à un nettoyage manuel.

test("la restauration RETIRE le journal de migration périmé en inscrivant son manifeste", async () => {
  const retires = [];
  const inscrits = [];
  const cible = createOpfsImportTarget("vault-app", {
    stat: () => Promise.resolve({ present: true, size: TAILLE }),
    readManifest: () => Promise.resolve(null),
    writeManifest: (nom, bytes) => {
      inscrits.push(nom);
      return Promise.resolve(bytes);
    },
    removeSidecar: (nom) => {
      retires.push(nom);
      return Promise.resolve();
    },
  });

  await cible.commitManifest(serializeManifest(manifesteValide()));

  assert.deepEqual(inscrits, ["vault-app.manifest"]);
  assert.deepEqual(retires, ["vault-app.migration"]);
});

// --- Le journal de génération d'un volume écrasé (#16) -------------------------------------------

/** Cible instrumentée : elle note l'ORDRE des gestes, seule chose qui compte ici. */
function cibleInstrumentee({ ouvrir } = {}) {
  const gestes = [];
  const cible = createOpfsImportTarget("vault-app", {
    stat: () => Promise.resolve({ present: true, size: TAILLE }),
    readManifest: () => Promise.resolve(serializeManifest(manifesteValide())),
    revoke: async () => {
      gestes.push("revoque-manifeste");
      return true;
    },
    writeManifest: async () => gestes.push("inscrit-manifeste"),
    removeSidecar: async (nom) => {
      gestes.push(`retire:${nom}`);
      return true;
    },
    openVolume: async () => {
      gestes.push("ouvre-volume");
      if (ouvrir !== undefined) return ouvrir();
      return { size: () => TAILLE, close: async () => gestes.push("ferme-volume") };
    },
  });
  return { cible, gestes };
}

test("OUVRIR le volume ne retire PAS le journal de génération", async () => {
  // Le défaut CRITIQUE de la revue de #90. `open()` retirait `<volume>.gen` AVANT d'acquérir le
  // handle. Un second onglet détenant le volume (#8), un handle perdu ou un quota faisait alors
  // échouer l'ouverture — refus propre, manifeste jamais révoqué, volume « intact » — mais la
  // dernière barrière ACQUITTÉE du guest avait déjà été effacée, hors de tout code
  // `VAULT_STORAGE_GENERATION_*`. Ouvrir est une question, pas une mutation.
  const { cible, gestes } = cibleInstrumentee();
  await cible.open({ size: TAILLE });
  assert.deepEqual(gestes, ["ouvre-volume"]);
  assert.ok(
    !gestes.some((geste) => geste.startsWith("retire:")),
    "aucun voisin ne doit être retiré par une ouverture",
  );
});

test("une ouverture qui ÉCHOUE laisse le journal de génération intact", async () => {
  const { cible, gestes } = cibleInstrumentee({
    ouvrir: () => {
      throw new StorageError(STORAGE_ERROR_CODES.busy, "Un second onglet détient le volume.");
    },
  });

  await assert.rejects(
    () => cible.open({ size: TAILLE }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );
  assert.deepEqual(gestes, ["ouvre-volume"], "le volume refusé reste entier, journal compris");
});

test("le journal de génération n'est retiré qu'APRÈS la révocation du manifeste", async () => {
  // L'ordre est le contrat. Révoquer d'abord rend le volume NON IDENTIFIÉ : une coupure entre les
  // deux gestes laisse un volume que le boot refuse, ce qui est sûr. Retirer le journal d'abord
  // laisserait un volume ENCORE identifié dont la dernière génération acquittée a disparu.
  const { cible, gestes } = cibleInstrumentee();
  await cible.open({ size: TAILLE });
  await cible.revokeManifest();
  await cible.discardGeneration();

  assert.deepEqual(gestes, ["ouvre-volume", "revoque-manifeste", "retire:vault-app.gen"]);
});
