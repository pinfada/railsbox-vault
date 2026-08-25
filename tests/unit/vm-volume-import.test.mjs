import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import { ARCHIVE_ERROR_CODES, isArchiveError } from "../../src/vm/archive-errors.mjs";
import { IMPORT_ERROR_CODES, isImportError } from "../../src/vm/import-errors.mjs";
import { BUDGET_DIAGNOSTIC_CODES } from "../../src/vm/storage-budget.mjs";
import { createSha256Stream } from "../../src/vm/sha256-stream.mjs";
import { CONSISTENCY_KINDS, exportVolumeToBytes } from "../../src/vm/volume-export.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import {
  DEFAULT_IMPORT_BLOCK_BYTES,
  importArchive,
  manifestSidecarName,
} from "../../src/vm/volume-import.mjs";

// Preuve unitaire de la RESTAURATION (#12, `VAULT-PORT-001`) sur des doubles déterministes. Elle
// éprouve l'ordre imposé par l'ADR 0009 — vérifier, refuser, révoquer, restaurer, re-vérifier,
// inscrire — et les REFUS typés : archive invalide (familles #10/#11 propagées telles quelles),
// cible non vide sans consentement, espace insuffisant (diagnostic #9), géométrie de cible
// incompatible, re-vérification divergente. Aucun OPFS, aucun navigateur : l'orchestration est
// pure ; la preuve sur vrai OPFS, avec changement d'origine réel et boot Rails, est le niveau
// Bout en bout (`tests/e2e/restauration-inter-origine.spec.mjs`).

/** Contenu de volume déterministe reproductible d'une RÈGLE (aucun binaire versionné). */
function octetA(index, seed) {
  return (index * 37 + seed * 61 + 7) & 0xff;
}

function contenuVolume(size, seed = 3) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = octetA(i, seed);
  return bytes;
}

function manifeste(volumeSize) {
  return createManifest({
    runtime: { version: "1.4.2", artifact: "sha256:abcdef" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize,
    identity: { algorithm: "sha-256", digest: null },
  });
}

const cohérence = {
  kind: CONSISTENCY_KINDS.exclusiveHandle,
  detail: "volume lu via le handle exclusif",
};

/** Empreinte SHA-256 indépendante, calculée en flux, pour ne rien croire sur parole. */
function empreinte(bytes) {
  const hash = createSha256Stream();
  hash.update(bytes);
  return hash.digestHex();
}

/** Fabrique une archive v1 à partir d'un contenu en mémoire. */
async function archiveDe(contenu) {
  const source = {
    size: contenu.byteLength,
    read: (offset, length) => Promise.resolve(contenu.slice(offset, offset + length)),
  };
  return exportVolumeToBytes({
    source,
    manifest: manifeste(contenu.byteLength),
    consistency: cohérence,
  });
}

/** Source d'archive relisible, qui COMPTE la plus grande lecture reçue. */
function sourceArchive(bytes) {
  const compteur = { maxLecture: 0, appels: 0 };
  return {
    compteur,
    byteLength: bytes.byteLength,
    read(offset, length) {
      compteur.appels += 1;
      compteur.maxLecture = Math.max(compteur.maxLecture, length);
      return Promise.resolve(bytes.slice(offset, offset + length));
    },
  };
}

/**
 * Cible d'import en mémoire. Elle survit aux ouvertures successives — sans quoi « cible déjà
 * occupée » et l'idempotence ne voudraient rien dire —, compte les gestes de l'orchestration, et
 * peut imposer une géométrie ou corrompre sa relecture pour éprouver les refus.
 */
function cibleMemoire({
  contenu = null,
  manifestBytes = null,
  tailleImposee = null,
  corrompreRelecture = false,
} = {}) {
  const etat = {
    bytes: contenu,
    manifestBytes,
    ouvertures: 0,
    revocations: 0,
    commits: 0,
    flushes: 0,
    maxEcriture: 0,
    maxLecture: 0,
  };
  return {
    etat,
    inspect() {
      return Promise.resolve({
        present: etat.bytes !== null,
        size: etat.bytes === null ? 0 : etat.bytes.byteLength,
        manifestBytes: etat.manifestBytes,
      });
    },
    open({ size }) {
      etat.ouvertures += 1;
      const taille = tailleImposee ?? size;
      const bytes =
        etat.bytes !== null && etat.bytes.byteLength === taille
          ? etat.bytes.slice()
          : new Uint8Array(taille);
      return Promise.resolve({
        size: () => taille,
        read(offset, length) {
          etat.maxLecture = Math.max(etat.maxLecture, length);
          const lu = bytes.slice(offset, offset + length);
          if (corrompreRelecture && offset === 0 && lu.byteLength > 0) lu[0] ^= 0x01;
          return Promise.resolve(lu);
        },
        write(offset, morceau) {
          etat.maxEcriture = Math.max(etat.maxEcriture, morceau.byteLength);
          bytes.set(morceau, offset);
          return Promise.resolve();
        },
        flush() {
          etat.flushes += 1;
          return Promise.resolve();
        },
        close() {
          etat.bytes = bytes;
          return Promise.resolve();
        },
      });
    },
    revokeManifest() {
      etat.revocations += 1;
      etat.manifestBytes = null;
      return Promise.resolve();
    },
    commitManifest(bytes) {
      etat.commits += 1;
      etat.manifestBytes = bytes;
      return Promise.resolve();
    },
  };
}

/** Double de la couche budget (#9) : elle rend la réservation qu'on lui dicte. */
function budgetDouble(reservation) {
  return { reserve: () => Promise.resolve(reservation) };
}

test("une archive vérifiée restaure le volume octet pour octet, puis le manifeste est inscrit", async () => {
  const contenu = contenuVolume(8 * SECTOR_SIZE);
  const { archive, digest, manifest } = await archiveDe(contenu);
  const cible = cibleMemoire();

  const rapport = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    blockBytes: SECTOR_SIZE,
  });

  assert.equal(rapport.restored, true);
  assert.equal(rapport.contentDigest, digest);
  assert.equal(rapport.verifiedDigest, digest);
  assert.equal(rapport.volumeSize, contenu.byteLength);
  assert.deepEqual(cible.etat.bytes, contenu);
  assert.equal(empreinte(cible.etat.bytes), digest);
  // Le manifeste n'est inscrit qu'une fois, et c'est celui de l'archive, digest renseigné compris.
  assert.equal(cible.etat.commits, 1);
  assert.deepEqual(cible.etat.manifestBytes, serializeManifest(manifest));
  // Révocation AVANT la restauration : la cible cesse d'être présentée comme valide dès la mutation.
  assert.equal(cible.etat.revocations, 1);
  assert.ok(cible.etat.flushes >= 1, "la restauration franchit une barrière de durabilité");
});

test("une archive au contenu altéré est refusée AVANT toute mutation de la cible", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const altere = archive.slice();
  altere[altere.byteLength - 100] ^= 0x01;
  const cible = cibleMemoire();

  await assert.rejects(
    () => importArchive({ source: sourceArchive(altere), target: cible, blockBytes: SECTOR_SIZE }),
    (erreur) => isArchiveError(erreur, ARCHIVE_ERROR_CODES.digestMismatch),
  );

  assert.equal(cible.etat.bytes, null, "rien n'est écrit");
  assert.equal(cible.etat.ouvertures, 0, "la cible n'est même pas ouverte");
  assert.equal(cible.etat.revocations, 0);
  assert.equal(cible.etat.commits, 0);
});

test("une archive tronquée est refusée avant toute mutation", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire();

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive.slice(0, archive.byteLength - SECTOR_SIZE)),
        target: cible,
        blockBytes: SECTOR_SIZE,
      }),
    (erreur) => isArchiveError(erreur, ARCHIVE_ERROR_CODES.truncated),
  );
  assert.equal(cible.etat.ouvertures, 0);
});

test("une cible non vide est refusée sans consentement explicite, et reste intacte", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const occupant = contenuVolume(4 * SECTOR_SIZE, 9);
  const manifestePrecedent = serializeManifest(manifeste(occupant.byteLength));
  const cible = cibleMemoire({ contenu: occupant, manifestBytes: manifestePrecedent });

  await assert.rejects(
    () => importArchive({ source: sourceArchive(archive), target: cible, blockBytes: SECTOR_SIZE }),
    (erreur) => isImportError(erreur, IMPORT_ERROR_CODES.targetNotEmpty),
  );

  assert.deepEqual(cible.etat.bytes, occupant, "le volume occupant n'est pas touché");
  assert.deepEqual(
    cible.etat.manifestBytes,
    manifestePrecedent,
    "le manifeste du volume occupant reste en place",
  );
  assert.equal(cible.etat.ouvertures, 0);
  assert.equal(cible.etat.revocations, 0);
});

test("avec consentement explicite, la cible non vide est écrasée puis re-vérifiée", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive, digest } = await archiveDe(contenu);
  const cible = cibleMemoire({ contenu: contenuVolume(4 * SECTOR_SIZE, 9) });

  const rapport = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    blockBytes: SECTOR_SIZE,
    overwrite: true,
  });

  assert.equal(rapport.restored, true);
  assert.equal(rapport.overwritten, true);
  assert.deepEqual(cible.etat.bytes, contenu);
  assert.equal(rapport.verifiedDigest, digest);
});

test("le manifeste n'est inscrit qu'APRÈS la re-vérification : une relecture divergente est refusée", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire({ corrompreRelecture: true });

  await assert.rejects(
    () => importArchive({ source: sourceArchive(archive), target: cible, blockBytes: SECTOR_SIZE }),
    (erreur) => isImportError(erreur, IMPORT_ERROR_CODES.verificationFailed),
  );

  // La cible porte des octets, mais AUCUN manifeste : elle n'est pas présentée comme valide, et
  // `assertVolumeWritable` (#10) la refusera par `VAULT_MANIFEST_UNIDENTIFIED`.
  assert.equal(cible.etat.commits, 0);
  assert.equal(cible.etat.manifestBytes, null);
  assert.equal(cible.etat.revocations, 1);
});

test("la restauration est en flux : aucune lecture ni écriture ne dépasse le bloc", async () => {
  const contenu = contenuVolume(64 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const source = sourceArchive(archive);
  const cible = cibleMemoire();
  const blockBytes = 4 * SECTOR_SIZE;

  const rapport = await importArchive({ source, target: cible, blockBytes });

  assert.ok(
    source.compteur.maxLecture <= blockBytes,
    "aucune lecture d'archive ne dépasse le bloc",
  );
  assert.ok(cible.etat.maxEcriture <= blockBytes, "aucune écriture ne dépasse le bloc");
  assert.ok(cible.etat.maxLecture <= blockBytes, "aucune relecture ne dépasse le bloc");
  assert.equal(rapport.maxSourceReadBytes, source.compteur.maxLecture);
  assert.ok(rapport.maxTargetWriteBytes <= blockBytes);
  assert.ok(DEFAULT_IMPORT_BLOCK_BYTES <= 64 * 1024 * 1024, "le bloc par défaut tient le budget");
});

test("un espace insuffisant est refusé AVANT toute mutation, avec le diagnostic de #9", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire();
  const budget = budgetDouble({
    operation: "reserve",
    state: "known",
    requiredBytes: contenu.byteLength,
    available: 16,
    sufficient: false,
    diagnostic: {
      code: BUDGET_DIAGNOSTIC_CODES.spaceLow,
      toJSON: () => ({ code: BUDGET_DIAGNOSTIC_CODES.spaceLow }),
    },
  });

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: cible,
        budget,
        blockBytes: SECTOR_SIZE,
      }),
    (erreur) =>
      isImportError(erreur, IMPORT_ERROR_CODES.spaceInsufficient) &&
      erreur.context.diagnostic.code === BUDGET_DIAGNOSTIC_CODES.spaceLow,
  );

  assert.equal(cible.etat.ouvertures, 0);
  assert.equal(cible.etat.revocations, 0);
});

test("une estimation indisponible n'est pas une capacité nulle : la restauration se poursuit", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive, digest } = await archiveDe(contenu);
  const cible = cibleMemoire();
  const budget = budgetDouble({
    operation: "reserve",
    state: "unknown",
    requiredBytes: contenu.byteLength,
    available: null,
    sufficient: null,
    diagnostic: {
      code: BUDGET_DIAGNOSTIC_CODES.estimateUnavailable,
      toJSON: () => ({ code: BUDGET_DIAGNOSTIC_CODES.estimateUnavailable }),
    },
  });

  const rapport = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    budget,
    blockBytes: SECTOR_SIZE,
  });

  assert.equal(rapport.restored, true);
  assert.equal(rapport.verifiedDigest, digest);
  assert.equal(rapport.budget.state, "unknown");
  assert.equal(rapport.budget.diagnostic.code, BUDGET_DIAGNOSTIC_CODES.estimateUnavailable);
});

test("une géométrie de cible incompatible est refusée, manifeste laissé révoqué", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire({ tailleImposee: 8 * SECTOR_SIZE });

  await assert.rejects(
    () => importArchive({ source: sourceArchive(archive), target: cible, blockBytes: SECTOR_SIZE }),
    (erreur) => isImportError(erreur, IMPORT_ERROR_CODES.geometryMismatch),
  );

  assert.equal(cible.etat.commits, 0);
  assert.equal(cible.etat.manifestBytes, null);
});

test("un manifeste d'une autre application est refusé, ManifestError propagée telle quelle", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire();

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: cible,
        blockBytes: SECTOR_SIZE,
        expectations: { app: { id: "railsbox/autre" } },
      }),
    (erreur) => isManifestError(erreur, MANIFEST_ERROR_CODES.identityMismatch),
  );

  assert.equal(cible.etat.ouvertures, 0);
});

test("restaurer deux fois la même archive rend exactement le même volume", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive, digest } = await archiveDe(contenu);
  const cible = cibleMemoire();

  const premier = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    blockBytes: SECTOR_SIZE,
  });
  const second = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    blockBytes: SECTOR_SIZE,
    overwrite: true,
  });

  assert.equal(premier.verifiedDigest, digest);
  assert.equal(second.verifiedDigest, digest);
  assert.deepEqual(cible.etat.bytes, contenu);
  assert.equal(cible.etat.commits, 2);
});

test("le nom du manifeste dérive du volume et reste un nom de volume admissible", () => {
  assert.equal(manifestSidecarName("vault-app"), "vault-app.manifest");
  assert.throws(() => manifestSidecarName("Vault-App"), TypeError);
  assert.throws(() => manifestSidecarName("v".repeat(60)), RangeError);
});
