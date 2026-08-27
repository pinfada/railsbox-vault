import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { createManifest, MANIFEST_FORMAT_VERSION } from "../../src/vm/volume-manifest.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import { ARCHIVE_ERROR_CODES, isArchiveError } from "../../src/vm/archive-errors.mjs";
import { createSha256Stream } from "../../src/vm/sha256-stream.mjs";
import {
  ARCHIVE_MAGIC,
  CONSISTENCY_KINDS,
  PREAMBLE_BYTES,
  exportVolumeToBytes,
  hasArchiveMagic,
  readArchive,
  verifyArchive,
  writeArchive,
} from "../../src/vm/volume-export.mjs";

// Preuve unitaire de l'EXPORT VÉRIFIABLE (#11, `VAULT-PORT-001`) sur des doubles déterministes.
// Elle éprouve le codec d'archive, l'empreinte de contenu inscrite dans le manifeste, le streaming à
// surmémoire bornée, la garantie de point cohérent exigée, et les REFUS typés (troncature, empreinte
// non concordante, marqueur/en-tête méconnaissable, manifeste incompatible via #10). Aucun OPFS,
// aucun navigateur : le codec est pur ; la preuve sur vrai OPFS + guest Rails est le niveau E2E.

/** Contenu de volume déterministe reproductible d'une RÈGLE (aucun binaire versionné). */
function octetA(index, seed) {
  return (index * 31 + seed * 97 + 11) & 0xff;
}

/**
 * Source de volume en mémoire, relisible et déterministe. Elle COMPTE la plus grande lecture reçue :
 * un export à surmémoire bornée ne doit jamais demander tout le volume d'un coup.
 */
function sourceVolume(size, seed = 5) {
  const compteur = { maxLecture: 0, appels: 0 };
  return {
    compteur,
    size,
    read(offset, length) {
      compteur.appels += 1;
      compteur.maxLecture = Math.max(compteur.maxLecture, length);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = octetA(offset + i, seed);
      return Promise.resolve(bytes);
    },
  };
}

/** Empreinte SHA-256 indépendante de tout le contenu du volume, en streaming. */
async function digestVolume(source) {
  const hash = createSha256Stream();
  for (let offset = 0; offset < source.size; offset += 1024) {
    hash.update(await source.read(offset, Math.min(1024, source.size - offset)));
  }
  return hash.digestHex();
}

function manifeste(volumeSize) {
  return createManifest({
    runtime: { version: "1.4.2", artifact: "sha256:abcdef", minWriter: "1.0.0" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize,
    identity: { algorithm: "sha-256", digest: null },
    // Bloc « volume » du format v3 (#18, ADR 0016) : identifiant opaque et algorithme épinglé.
    volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" },
  });
}

/**
 * Réécrit l'en-tête JSON d'une archive après l'avoir laissé modifier. Le préambule est recalculé :
 * l'archive reste STRUCTURELLEMENT valide, ce qui est exactement le point — seul le contenu de
 * l'en-tête ment, et c'est la validation qui doit s'en apercevoir.
 */
function archiveAvecEnTete(archive, modifier) {
  const vue = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const longueur = vue.getUint32(ARCHIVE_MAGIC.byteLength, false);
  const debut = PREAMBLE_BYTES;
  const entete = JSON.parse(new TextDecoder().decode(archive.subarray(debut, debut + longueur)));
  modifier(entete);
  const octets = new TextEncoder().encode(JSON.stringify(entete));
  const contenu = archive.subarray(debut + longueur);
  const refaite = new Uint8Array(PREAMBLE_BYTES + octets.byteLength + contenu.byteLength);
  refaite.set(ARCHIVE_MAGIC, 0);
  new DataView(refaite.buffer).setUint32(ARCHIVE_MAGIC.byteLength, octets.byteLength, false);
  refaite.set(octets, PREAMBLE_BYTES);
  refaite.set(contenu, PREAMBLE_BYTES + octets.byteLength);
  return refaite;
}

const cohérence = {
  kind: CONSISTENCY_KINDS.lease,
  detail: "bail détenu, aucun écrivain concurrent",
};

test("aller-retour : l'archive se vérifie et porte l'empreinte du contenu dans le manifeste", async () => {
  const source = sourceVolume(64 * 1024);
  const attendu = await digestVolume(source);

  const { archive, digest, manifest, archiveLength } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });

  // L'empreinte calculée est bien celle du CONTENU, et elle est inscrite dans identity.digest (#10).
  assert.equal(digest, attendu);
  assert.equal(manifest.identity.digest, attendu);
  assert.equal(manifest.formatVersion, MANIFEST_FORMAT_VERSION);
  assert.equal(archive.byteLength, archiveLength);

  const verdict = await verifyArchive(archive);
  assert.equal(verdict.contentDigest, attendu);
  assert.equal(verdict.manifest.identity.digest, attendu);
  assert.equal(verdict.contentLength, source.size);
  assert.equal(verdict.consistency.kind, CONSISTENCY_KINDS.lease);
});

test("archive ≤ 2× la taille logique et en-tête de quelques centaines d'octets", async () => {
  const source = sourceVolume(64 * 1024);
  const { archive, headerLength } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  assert.ok(
    archive.byteLength <= 2 * source.size,
    `archive ${archive.byteLength} ≤ 2×${source.size}`,
  );
  assert.ok(headerLength < 1024, `en-tête ${headerLength} octets`);
  // Surcoût = préambule + en-tête ; le reste est le contenu octet pour octet.
  assert.equal(archive.byteLength, PREAMBLE_BYTES + headerLength + source.size);
});

test("streaming à surmémoire bornée : aucune lecture ne dépasse la taille de bloc", async () => {
  const source = sourceVolume(200 * 1024);
  const blockBytes = 16 * 1024;
  const chunks = [];
  await writeArchive({
    source,
    sink: { write: (bytes) => void chunks.push(bytes.slice()) },
    manifest: manifeste(source.size),
    consistency: cohérence,
    blockBytes,
  });
  // Ni la passe d'empreinte ni la passe de recopie ne demandent tout le volume d'un coup.
  assert.ok(
    source.compteur.maxLecture <= blockBytes,
    `plus grande lecture ${source.compteur.maxLecture} ≤ bloc ${blockBytes}`,
  );
  assert.ok(source.compteur.appels >= (source.size / blockBytes) * 2, "deux passes en flux");
});

test("la vérification en streaming borne aussi ses lectures", async () => {
  const source = sourceVolume(200 * 1024);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  let maxLecture = 0;
  const read = (offset, length) => {
    maxLecture = Math.max(maxLecture, length);
    return archive.subarray(offset, offset + length);
  };
  const blockBytes = 8 * 1024;
  const verdict = await readArchive({ read, byteLength: archive.byteLength, blockBytes });
  assert.equal(verdict.contentLength, source.size);
  assert.ok(maxLecture <= blockBytes, `plus grande lecture ${maxLecture} ≤ bloc ${blockBytes}`);
});

test("un octet de contenu altéré : empreinte non concordante, jamais un succès silencieux", async () => {
  const source = sourceVolume(8 * 1024);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  const altérée = archive.slice();
  altérée[altérée.byteLength - 100] ^= 0x01; // un bit du contenu
  await assert.rejects(
    () => verifyArchive(altérée),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.digestMismatch),
  );
});

test("archive tronquée : refus typé, jamais complétée par des zéros", async () => {
  const source = sourceVolume(8 * 1024);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  const tronquée = archive.slice(0, archive.byteLength - 512);
  await assert.rejects(
    () => verifyArchive(tronquée),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.truncated),
  );
  // Trop court même pour le préambule.
  await assert.rejects(
    () => verifyArchive(archive.slice(0, PREAMBLE_BYTES - 1)),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.truncated),
  );
});

test("marqueur binaire absent : archive malformée", async () => {
  const source = sourceVolume(8 * 1024);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  const sansMarqueur = archive.slice();
  sansMarqueur[0] ^= 0xff;
  await assert.rejects(
    () => verifyArchive(sansMarqueur),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.malformed),
  );
  // Le marqueur attendu est bien celui de tête.
  assert.deepEqual([...archive.subarray(0, ARCHIVE_MAGIC.byteLength)], [...ARCHIVE_MAGIC]);
});

test("en-tête JSON corrompu : archive malformée", async () => {
  const source = sourceVolume(8 * 1024);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  const corrompue = archive.slice();
  // Le premier octet d'en-tête est '{' ; le remplacer casse le JSON sans toucher à sa longueur.
  corrompue[PREAMBLE_BYTES] = 0x40; // '@'
  await assert.rejects(
    () => verifyArchive(corrompue),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.malformed),
  );
});

test("manifeste incompatible : le refus typé de #10 est propagé, pas reconditionné", async () => {
  const source = sourceVolume(8 * 1024);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  // L'application en cours n'est pas celle qui possède le volume : refus #10, pas #11.
  await assert.rejects(
    () =>
      verifyArchive(archive, {
        expectations: { app: { id: "autre/app", version: "1.0.0" } },
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.identityMismatch),
  );
});

test("export refusé sans garantie de cohérence déclarée", async () => {
  const source = sourceVolume(SECTOR_SIZE * 4);
  await assert.rejects(
    () => exportVolumeToBytes({ source, manifest: manifeste(source.size) }),
    TypeError,
  );
  await assert.rejects(
    () =>
      exportVolumeToBytes({
        source,
        manifest: manifeste(source.size),
        consistency: { kind: "invente" },
      }),
    TypeError,
  );
});

test("export refusé si le manifeste et la source divergent en géométrie", async () => {
  const source = sourceVolume(SECTOR_SIZE * 4);
  await assert.rejects(
    () =>
      exportVolumeToBytes({
        source,
        manifest: manifeste(SECTOR_SIZE * 8), // taille déclarée ≠ taille réelle
        consistency: cohérence,
      }),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.geometryMismatch),
  );
});

test("la compatibilité du manifeste est vérifiée PAR DÉFAUT, sans attente à fournir", async () => {
  // Un contrôle qui ne s'exécute que si l'appelant pense à le demander n'est pas un contrôle : une
  // archive d'un format que ce runtime ne sait pas lire doit être refusée d'office.
  const source = sourceVolume(SECTOR_SIZE * 4);
  const futur = createManifest({
    formatVersion: MANIFEST_FORMAT_VERSION + 1,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize: source.size,
    identity: { algorithm: "sha-256", digest: null },
    volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" },
  });
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: futur,
    consistency: cohérence,
  });

  await assert.rejects(
    () => verifyArchive(archive),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.formatTooNew),
  );

  // La dérogation existe, mais elle est NOMMÉE : un outil de diagnostic peut lire un conteneur
  // qu'il ne saurait pas ouvrir en écriture, à condition de le dire.
  const verdict = await verifyArchive(archive, { enforceCompatibility: false });
  assert.equal(verdict.manifest.formatVersion, MANIFEST_FORMAT_VERSION + 1);
});

test("l'algorithme d'empreinte est ÉPINGLÉ : une étiquette mensongère est refusée", async () => {
  // L'archive ne porte qu'un seul algorithme et le calcule elle-même. Laisser passer une autre
  // étiquette rendrait persistante une affirmation que le code ne tient pas.
  const source = sourceVolume(SECTOR_SIZE * 4);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  const falsifiee = archiveAvecEnTete(archive, (entete) => {
    entete.content.algorithm = "sha-1";
  });
  await assert.rejects(
    () => verifyArchive(falsifiee),
    (e) => isArchiveError(e, ARCHIVE_ERROR_CODES.malformed),
  );
});

test("le marqueur d'archive est reconnaissable AVANT toute interprétation", async () => {
  const source = sourceVolume(SECTOR_SIZE * 4);
  const { archive } = await exportVolumeToBytes({
    source,
    manifest: manifeste(source.size),
    consistency: cohérence,
  });
  assert.equal(hasArchiveMagic(archive), true);
  assert.equal(hasArchiveMagic(archive.subarray(0, ARCHIVE_MAGIC.byteLength)), true);
  // Un volume brut — des octets quelconques — n'est pas une archive, et huit octets suffisent à le dire.
  assert.equal(hasArchiveMagic(new Uint8Array(64)), false);
  assert.equal(hasArchiveMagic(new Uint8Array(4)), false);
});

test("les trois garanties de cohérence connues sont acceptées et inscrites", async () => {
  for (const kind of Object.values(CONSISTENCY_KINDS)) {
    const source = sourceVolume(SECTOR_SIZE * 4);
    const { archive } = await exportVolumeToBytes({
      source,
      manifest: manifeste(source.size),
      consistency: { kind },
    });
    const verdict = await verifyArchive(archive);
    assert.equal(verdict.consistency.kind, kind);
  }
});
