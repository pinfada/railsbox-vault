import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { FAULT_KINDS, createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "../../src/vm/storage-errors.mjs";
import {
  MAX_STORAGE_NAME,
  MAX_VOLUME_NAME,
  instantaneSidecarName,
  assertVolumeName,
  migrationJournalName,
} from "../../src/vm/opfs-sync-access.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import { ARCHIVE_ERROR_CODES, isArchiveError } from "../../src/vm/archive-errors.mjs";
import { IMPORT_ERROR_CODES, isImportError } from "../../src/vm/import-errors.mjs";
import { BUDGET_DIAGNOSTIC_CODES } from "../../src/vm/storage-budget.mjs";
import { createSha256Stream } from "../../src/vm/sha256-stream.mjs";
import { CONSISTENCY_KINDS, exportVolumeToBytes } from "../../src/vm/volume-export.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  serializeManifest,
} from "../../src/vm/volume-manifest.mjs";
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
    runtime: { version: "1.4.2", artifact: "sha256:abcdef", minWriter: "1.0.0" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize,
    identity: { algorithm: "sha-256", digest: null },
    // FORMAT v2, et c'est délibéré (#18, ADR 0016) : ces suites éprouvent le CODEC d'archive, pas le
    // format de volume. L'archive d'un volume v3 est refusée par ce chemin — elle doit porter le
    // fichier chiffré TEL QUEL, ce que la tranche (b) livrera —, et
    // `tests/unit/vm-archive-volume-chiffre.test.mjs` éprouve ce refus. Exporter ici un manifeste v3
    // ne mesurerait donc plus que lui.
    formatVersion: 2,
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
 * peut imposer une géométrie, corrompre sa relecture ou TOMBER EN PANNE pour éprouver les refus.
 *
 * Les pannes d'écriture et de barrière viennent du `FaultPlan` du dépôt (#4) : le même instrument
 * déterministe que le backend de blocs, et non un `throw` improvisé. `FaultPlan` ne modélise en
 * revanche ni l'OUVERTURE ni l'inscription du manifeste, qui ne sont pas des opérations de bloc :
 * celles-là sont injectées explicitement.
 */
function cibleMemoire({
  contenu = null,
  manifestBytes = null,
  tailleImposee = null,
  corrompreRelecture = false,
  faults = createFaultPlan(),
  panneOuverture = null,
  panneCommit = null,
} = {}) {
  const etat = {
    bytes: contenu,
    manifestBytes,
    ouvertures: 0,
    fermetures: 0,
    revocations: 0,
    generationsEcartees: 0,
    gestes: [],
    commits: 0,
    flushes: 0,
    maxEcriture: 0,
    maxLecture: 0,
    blocsEcrits: 0,
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
      if (panneOuverture !== null) return Promise.reject(panneOuverture);
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
          const faute = faults.consume("write");
          if (faute?.kind === FAULT_KINDS.partialWrite) {
            return Promise.reject(
              new StorageError(
                STORAGE_ERROR_CODES.quotaExceeded,
                `Quota dépassé à l'offset ${offset} du volume cible.`,
                { offset },
              ),
            );
          }
          etat.maxEcriture = Math.max(etat.maxEcriture, morceau.byteLength);
          etat.blocsEcrits += 1;
          bytes.set(morceau, offset);
          return Promise.resolve();
        },
        flush() {
          const faute = faults.consume("flush");
          if (faute?.kind === FAULT_KINDS.flushFailure) {
            return Promise.reject(
              new StorageError(
                STORAGE_ERROR_CODES.flushFailed,
                "Barrière de durabilité refusée par la cible.",
              ),
            );
          }
          etat.flushes += 1;
          return Promise.resolve();
        },
        close() {
          etat.fermetures += 1;
          etat.bytes = bytes;
          return Promise.resolve();
        },
      });
    },
    revokeManifest() {
      etat.revocations += 1;
      etat.gestes.push("revoque-manifeste");
      etat.manifestBytes = null;
      return Promise.resolve();
    },
    discardGeneration() {
      etat.generationsEcartees += 1;
      etat.gestes.push("ecarte-generation");
      return Promise.resolve(true);
    },
    commitManifest(bytes) {
      if (panneCommit !== null) return Promise.reject(panneCommit);
      etat.commits += 1;
      etat.gestes.push("inscrit-manifeste");
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
  assert.equal(rapport.maxTargetReadBytes, cible.etat.maxLecture);

  // Le bloc PAR DÉFAUT est celui qu'une restauration non paramétrée emploie réellement, et il tient
  // le budget : on l'éprouve par le comportement observé, non par une comparaison de constantes.
  const parDefaut = cibleMemoire();
  const rapportParDefaut = await importArchive({
    source: sourceArchive(archive),
    target: parDefaut,
  });
  assert.equal(rapportParDefaut.blockBytes, DEFAULT_IMPORT_BLOCK_BYTES);
  assert.ok(parDefaut.etat.maxEcriture <= 64 * 1024 * 1024);
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

test("le nom du manifeste dérive du volume et tient toujours dans la frontière de nommage", () => {
  assert.equal(manifestSidecarName("vault-app"), "vault-app.manifest");
  assert.throws(() => manifestSidecarName("Vault-App"), TypeError);
  // Le nom le plus long ADMIS porte encore TOUS ses voisins, y compris le plus long d'entre eux
  // (l'instantané de reprise, #65) : plus aucun volume n'est créable puis irrestaurable, immigrable
  // ou incapturable faute de place.
  const limite = "v".repeat(MAX_VOLUME_NAME);
  assert.equal(manifestSidecarName(limite).length <= MAX_STORAGE_NAME, true);
  assert.equal(migrationJournalName(limite).length <= MAX_STORAGE_NAME, true);
  assert.equal(instantaneSidecarName(limite).length, MAX_STORAGE_NAME);
  assert.throws(() => manifestSidecarName("v".repeat(MAX_VOLUME_NAME + 1)), TypeError);
});

test("la borne d'un nom de volume vaut 53 : 53 est admis, 54 est refusé", () => {
  // La valeur est ÉPINGLÉE, pas seulement dérivée : 55 avec le journal de migration (#13), 54
  // ensuite, et 53 depuis que l'instantané de reprise (#65, ADR 0024) est devenu le plus long des
  // voisins réservés. C'est une RÉTROACTIVITÉ — un nom de 54 caractères créable hier ne l'est plus
  // (ADR 0011) —, et une rétroactivité qu'aucun test n'épingle finit par se reperdre au premier
  // suffixe ajouté. Elle est écrite dans l'ADR 0024, décision 1.
  assert.equal(MAX_VOLUME_NAME, 53);
  const admis = "v".repeat(53);
  assert.equal(assertVolumeName(admis), admis);
  assert.equal(instantaneSidecarName(admis).length, MAX_STORAGE_NAME);
  assert.throws(() => assertVolumeName("v".repeat(54)), TypeError);
});

test("les suffixes des voisins sont RÉSERVÉS : aucun volume ne peut les porter", () => {
  // Sans cette réserve, restaurer « donnees » détruirait un volume légitime « donnees.manifest ».
  assert.throws(() => assertVolumeName("donnees.manifest"), TypeError);
  assert.throws(() => manifestSidecarName("donnees.manifest"), TypeError);
  assert.throws(() => assertVolumeName("donnees.migration"), TypeError);
  // Un nom qui contient le mot sans en faire son suffixe reste admis.
  assert.equal(assertVolumeName("donnees.manifeste-2"), "donnees.manifeste-2");
});

// --- Défaillance EN COURS de restauration (ADR 0009) -------------------------------------------
//
// Le contrat ne dit pas seulement ce qui arrive quand tout va bien : il dit qu'une interruption, à
// N'IMPORTE QUEL moment, laisse un volume NON IDENTIFIÉ plutôt qu'un volume d'apparence valide.
// Ces épreuves coupent la restauration à chacun de ses points de rupture.

test("panne à l'OUVERTURE de la cible : le manifeste existant n'est PAS détruit", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const precedent = serializeManifest(manifeste(contenu.byteLength));
  const cible = cibleMemoire({
    contenu: contenuVolume(4 * SECTOR_SIZE, 9),
    manifestBytes: precedent,
    panneOuverture: new StorageError(
      STORAGE_ERROR_CODES.busy,
      "Le volume est déjà ouvert en exclusivité dans un autre onglet.",
    ),
  });

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: cible,
        blockBytes: SECTOR_SIZE,
        overwrite: true,
      }),
    (erreur) => erreur.code === STORAGE_ERROR_CODES.busy,
  );

  // L'ouverture ayant échoué, aucun octet n'a pu être écrit : révoquer le manifeste aurait rendu un
  // volume intact inutilisable, par la seule faute du produit.
  assert.deepEqual(
    cible.etat.manifestBytes,
    precedent,
    "le manifeste survit à une ouverture ratée",
  );
  assert.equal(cible.etat.revocations, 0);
  assert.equal(cible.etat.commits, 0);
});

test("panne d'ÉCRITURE au troisième bloc : manifeste révoqué, cible refermée, aucun commit", async () => {
  const contenu = contenuVolume(8 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire({
    manifestBytes: serializeManifest(manifeste(contenu.byteLength)),
    faults: createFaultPlan([
      { kind: FAULT_KINDS.partialWrite, operation: "write", occurrence: 3 },
    ]),
  });

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: cible,
        blockBytes: SECTOR_SIZE,
        overwrite: true,
      }),
    (erreur) => erreur.code === STORAGE_ERROR_CODES.quotaExceeded,
  );

  assert.equal(cible.etat.blocsEcrits, 2, "la panne survient bien en cours de restauration");
  assert.equal(cible.etat.manifestBytes, null, "le volume reste NON identifié");
  assert.equal(cible.etat.commits, 0);
  assert.equal(cible.etat.fermetures, 1, "le handle exclusif est rendu malgré l'exception");
});

test("panne de BARRIÈRE : manifeste révoqué, cible refermée, aucun commit", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire({
    manifestBytes: serializeManifest(manifeste(contenu.byteLength)),
    faults: createFaultPlan([
      { kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 1 },
    ]),
  });

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: cible,
        blockBytes: SECTOR_SIZE,
        overwrite: true,
      }),
    (erreur) => erreur.code === STORAGE_ERROR_CODES.flushFailed,
  );

  assert.equal(cible.etat.manifestBytes, null);
  assert.equal(cible.etat.commits, 0);
  assert.equal(cible.etat.fermetures, 1);
});

test("panne à l'INSCRIPTION du manifeste : le volume reste non identifié", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire({
    panneCommit: new StorageError(
      STORAGE_ERROR_CODES.quotaExceeded,
      "Quota dépassé à l'inscription du manifeste.",
    ),
  });

  await assert.rejects(
    () => importArchive({ source: sourceArchive(archive), target: cible, blockBytes: SECTOR_SIZE }),
    (erreur) => erreur.code === STORAGE_ERROR_CODES.quotaExceeded,
  );

  // Le contenu est bien là, mais rien ne l'identifie : c'est exactement l'état sûr recherché.
  assert.deepEqual(cible.etat.bytes, contenu);
  assert.equal(cible.etat.manifestBytes, null);
  assert.equal(cible.etat.fermetures, 1);
});

test("une restauration interrompue se reprend avec consentement, et sans lui reste refusée", async () => {
  const contenu = contenuVolume(8 * SECTOR_SIZE);
  const { archive, digest } = await archiveDe(contenu);
  const interrompue = cibleMemoire({
    manifestBytes: serializeManifest(manifeste(contenu.byteLength)),
    faults: createFaultPlan([
      { kind: FAULT_KINDS.partialWrite, operation: "write", occurrence: 3 },
    ]),
  });
  await assert.rejects(() =>
    importArchive({
      source: sourceArchive(archive),
      target: interrompue,
      blockBytes: SECTOR_SIZE,
      overwrite: true,
    }),
  );

  // La cible porte désormais des octets partiels et AUCUN manifeste. Une reprise sans consentement
  // reste refusée : la restauration ne devine jamais qu'un volume occupé est un rebut.
  const reprise = cibleMemoire({ contenu: interrompue.etat.bytes, manifestBytes: null });
  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: reprise,
        blockBytes: SECTOR_SIZE,
      }),
    (erreur) =>
      isImportError(erreur, IMPORT_ERROR_CODES.targetNotEmpty) &&
      erreur.context.identified === false,
  );

  // Avec consentement, elle repart et rend un volume complet et identifié.
  const rapport = await importArchive({
    source: sourceArchive(archive),
    target: reprise,
    blockBytes: SECTOR_SIZE,
    overwrite: true,
  });
  assert.equal(rapport.verifiedDigest, digest);
  assert.deepEqual(reprise.etat.bytes, contenu);
});

// --- Voisin illisible, compatibilité par défaut, réservation nette ------------------------------

test("un voisin qui n'est pas un manifeste analysable est REFUSÉ, jamais supprimé", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const etranger = new TextEncoder().encode("des octets qui ne sont pas un manifeste Vault");
  const cible = cibleMemoire({ manifestBytes: etranger });

  await assert.rejects(
    () =>
      importArchive({
        source: sourceArchive(archive),
        target: cible,
        blockBytes: SECTOR_SIZE,
        overwrite: true,
      }),
    (erreur) => isImportError(erreur, IMPORT_ERROR_CODES.targetNotEmpty),
  );

  assert.deepEqual(cible.etat.manifestBytes, etranger, "le voisin étranger n'est pas détruit");
  assert.equal(cible.etat.revocations, 0);
  assert.equal(cible.etat.ouvertures, 0);
});

test("la compatibilité est contrôlée PAR DÉFAUT : un format futur est refusé sans rien demander", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const valide = await exportVolumeToBytes({
    source: {
      size: contenu.byteLength,
      read: (offset, length) => Promise.resolve(contenu.slice(offset, offset + length)),
    },
    manifest: manifeste(contenu.byteLength),
    consistency: cohérence,
  });
  // FORMAT FUTUR fabriqué APRÈS coup, en réécrivant l'en-tête d'une archive valide. L'export refuse
  // désormais tout manifeste v3 ou au-delà — un volume chiffré ne s'archive pas par ce chemin
  // (#18, ADR 0016) —, si bien qu'un manifeste futur passé à l'export mesurerait CE refus-là au lieu
  // du contrôle de compatibilité. L'`identity` est conservée : l'archive doit rester structurellement
  // valide, sinon le refus mesuré serait celui d'un en-tête divergent.
  const archive = archiveAvecManifesteFutur(valide.archive);
  const cible = cibleMemoire();

  // Aucune `expectations` n'est fournie : le contrôle ne doit PAS être facultatif pour autant.
  await assert.rejects(
    () => importArchive({ source: sourceArchive(archive), target: cible, blockBytes: SECTOR_SIZE }),
    (erreur) => isManifestError(erreur, MANIFEST_ERROR_CODES.formatTooNew),
  );
  assert.equal(cible.etat.ouvertures, 0);
});

test("l'écrasement sur place ne réserve que le besoin NET, jamais la taille totale", async () => {
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive, digest } = await archiveDe(contenu);
  const cible = cibleMemoire({ contenu: contenuVolume(4 * SECTOR_SIZE, 9) });
  const demandes = [];
  const budget = {
    reserve(octets) {
      demandes.push(octets);
      return Promise.resolve({
        operation: "reserve",
        state: "known",
        requiredBytes: octets,
        // L'espace libre est plus petit que le volume : une réservation brute échouerait à tort.
        available: SECTOR_SIZE,
        sufficient: octets <= SECTOR_SIZE,
        diagnostic: null,
      });
    },
  };

  const rapport = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    budget,
    blockBytes: SECTOR_SIZE,
    overwrite: true,
  });

  assert.deepEqual(demandes, [0], "un volume de même géométrie ne coûte aucun octet de plus");
  assert.equal(rapport.verifiedDigest, digest);
  assert.equal(rapport.budget.requiredBytes, 0);
});

test("l'ordre des gestes mutants : révoquer, écarter la génération, puis inscrire (#16)", async () => {
  // Le journal de génération d'un volume écrasé décrit un volume qui n'existera plus. L'écarter est
  // nécessaire — sans quoi le premier boot suivant rejouerait par-dessus le volume restauré — mais
  // c'est une MUTATION, et sa place dans la suite décide de ce qu'une coupure laisse :
  //
  //  - avant la révocation : le volume est encore IDENTIFIÉ et sa dernière barrière acquittée vient
  //    de disparaître. Un boot le prendrait pour valide ;
  //  - après : le volume est déjà non identifié, et le boot le refuse. C'est le seul état sûr.
  const contenu = contenuVolume(4 * SECTOR_SIZE);
  const { archive } = await archiveDe(contenu);
  const cible = cibleMemoire();

  const rapport = await importArchive({
    source: sourceArchive(archive),
    target: cible,
    blockBytes: SECTOR_SIZE,
  });

  assert.ok(rapport.volumeSize > 0);
  assert.equal(cible.etat.generationsEcartees, 1, "le journal de génération est écarté une fois");
  assert.deepEqual(cible.etat.gestes, [
    "revoque-manifeste",
    "ecarte-generation",
    "inscrit-manifeste",
  ]);
});

/**
 * Réécrit l'en-tête JSON d'une archive pour y déclarer un format FUTUR, préambule recalculé.
 *
 * Fabriquer l'archive avec un tel manifeste ne marche plus : l'export refuse tout format v3 ou
 * au-delà, un volume chiffré ne s'archivant pas par ce chemin (#18, ADR 0016). L'`identity` est
 * conservée, sinon le refus mesuré serait celui d'un en-tête divergent.
 */
function archiveAvecManifesteFutur(archive) {
  const vue = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const marqueur = 8;
  const longueur = vue.getUint32(marqueur, false);
  const debut = marqueur + 4;
  const entete = JSON.parse(new TextDecoder().decode(archive.subarray(debut, debut + longueur)));
  entete.manifest = {
    ...entete.manifest,
    formatVersion: MANIFEST_FORMAT_VERSION + 1,
    // Un format futur porterait le bloc « volume » comme le format courant : sans lui, le refus
    // mesuré serait « malformé » et non « format futur ».
    volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" },
  };
  const octets = new TextEncoder().encode(JSON.stringify(entete));
  const contenu = archive.subarray(debut + longueur);
  const refaite = new Uint8Array(debut + octets.byteLength + contenu.byteLength);
  refaite.set(archive.subarray(0, marqueur), 0);
  new DataView(refaite.buffer).setUint32(marqueur, octets.byteLength, false);
  refaite.set(octets, debut);
  refaite.set(contenu, debut + octets.byteLength);
  return refaite;
}
