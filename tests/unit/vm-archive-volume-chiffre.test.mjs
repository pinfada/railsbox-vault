// L'archive d'un volume CHIFFRÉ est refusée tant que la lecture brute n'existe pas (#18, ADR 0016).
//
// L'ADR 0016 tranche la question n° 6 de l'ADR 0015 : **l'archive porte le fichier v3 tel quel**,
// chiffré. Cette tranche (a) ne la met pas en œuvre — la source d'export lit par le chemin autorisé,
// qui DÉCHIFFRE, et la cible de restauration écrit par le même chemin, qui RECHIFFRE. Livrer cela
// tel quel produirait une archive **en clair** d'un volume chiffré, c'est-à-dire annulerait le
// chiffrement au repos dès que l'archive quitte l'appareil : exactement le mauvais côté de l'échange
// que l'ADR 0015 nomme.
//
// Un refus TYPÉ vaut mieux qu'une archive silencieusement en clair, et mieux qu'un refus emprunté à
// une autre cause — la restauration échouait jusqu'ici par `VAULT_STORAGE_CLE_REQUISE`, ce qui
// accusait la clé d'un manque qui est celui du CHEMIN. Le remède, lui, n'est pas une clé : c'est la
// tranche (b), #101.
//
// Ce que cette épreuve NE dit pas : que l'archive chiffrée est impossible. Elle est décidée, elle est
// spécifiée, et elle est ouverte.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { ARCHIVE_ERROR_CODES, isArchiveError } from "../../src/vm/archive-errors.mjs";
import { CONSISTENCY_KINDS, exportVolumeToBytes } from "../../src/vm/volume-export.mjs";
import { IMPORT_ERROR_CODES, isImportError } from "../../src/vm/import-errors.mjs";
import { importArchive } from "../../src/vm/volume-import.mjs";
import { createManifest } from "../../src/vm/volume-manifest.mjs";

const TAILLE = 4 * SECTOR_SIZE;
const COHERENCE = {
  kind: CONSISTENCY_KINDS.exclusiveHandle,
  detail: "volume lu via le handle exclusif",
};

function contenu() {
  return Uint8Array.from({ length: TAILLE }, (_, index) => (index * 7 + 3) & 0xff);
}

function source(octets) {
  return {
    size: octets.byteLength,
    read: (offset, length) => Promise.resolve(octets.slice(offset, offset + length)),
  };
}

function manifeste(formatVersion) {
  return createManifest({
    formatVersion,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    ...(formatVersion >= 3
      ? { volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" } }
      : {}),
  });
}

test("exporter un volume au format v3 est REFUSÉ, plutôt que rendu en clair", async () => {
  await assert.rejects(
    () =>
      exportVolumeToBytes({
        source: source(contenu()),
        manifest: manifeste(3),
        consistency: COHERENCE,
      }),
    (erreur) => {
      assert.ok(isArchiveError(erreur, ARCHIVE_ERROR_CODES.encryptedUnsupported), erreur.code);
      // Le message doit envoyer vers le bon remède. « Fournissez une clé » serait faux : la clé
      // n'y changerait rien, c'est le CHEMIN de lecture qui déchiffre.
      assert.match(erreur.message, /tel quel|brut/i);
      assert.match(erreur.message, /#101/);
      return true;
    },
  );
});

test("restaurer une archive dont le manifeste est v3 est REFUSÉ avant toute mutation", async () => {
  // La cible n'est même pas ouverte : le refus tombe sur le manifeste relu de l'archive, avant que
  // le moindre geste mutant n'ait lieu. C'est la règle de l'ADR 0009, appliquée à ce refus-ci.
  const gestes = [];
  const cible = {
    volume: "cible",
    async inspect() {
      gestes.push("inspect");
      return { present: false, size: 0, manifestBytes: null };
    },
    open() {
      gestes.push("open");
      throw new Error("la cible ne doit pas être ouverte");
    },
    revokeManifest() {
      gestes.push("revokeManifest");
    },
    commitManifest() {
      gestes.push("commitManifest");
    },
  };

  const { archive } = await exportVolumeToBytes({
    source: source(contenu()),
    manifest: manifeste(2),
    consistency: COHERENCE,
  });
  // L'archive est fabriquée au format v2 — le seul que l'export sache encore produire —, puis son
  // manifeste est remplacé par un v3. C'est exactement ce qu'une archive produite par une version
  // future ressemblerait, et c'est ce que la restauration doit refuser.
  const archiveV3 = archiveAvecManifeste(archive, manifeste(3));

  await assert.rejects(
    () =>
      importArchive({
        source: {
          byteLength: archiveV3.byteLength,
          read: (offset, length) => Promise.resolve(archiveV3.slice(offset, offset + length)),
        },
        target: cible,
      }),
    (erreur) => isImportError(erreur, IMPORT_ERROR_CODES.encryptedUnsupported),
  );
  // La cible n'est même pas INSPECTÉE : le refus tombe sur le manifeste que l'archive porte, juste
  // après sa vérification et avant que l'orchestration ne se tourne vers le volume. C'est plus tôt
  // que ce que l'ADR 0009 exige, et c'est tant mieux — poser une question ne doit rien fabriquer.
  assert.deepEqual(gestes, [], "la cible n'est ni inspectée, ni ouverte, ni révoquée");
});

/** Réécrit l'en-tête JSON d'une archive avec un autre manifeste, préambule recalculé. */
function archiveAvecManifeste(archive, manifest) {
  const vue = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const marqueur = 8;
  const longueur = vue.getUint32(marqueur, false);
  const entete = JSON.parse(
    new TextDecoder().decode(archive.subarray(marqueur + 4, marqueur + 4 + longueur)),
  );
  // L'empreinte de contenu est CONSERVÉE : l'archive doit rester structurellement valide, sans quoi
  // le refus mesuré serait celui d'un en-tête divergent et non celui d'un volume chiffré.
  const octets = new TextEncoder().encode(
    JSON.stringify({ ...entete, manifest: { ...manifest, identity: entete.manifest.identity } }),
  );
  const rendu = new Uint8Array(
    marqueur + 4 + octets.byteLength + (archive.byteLength - marqueur - 4 - longueur),
  );
  rendu.set(archive.subarray(0, marqueur), 0);
  new DataView(rendu.buffer).setUint32(marqueur, octets.byteLength, false);
  rendu.set(octets, marqueur + 4);
  rendu.set(archive.subarray(marqueur + 4 + longueur), marqueur + 4 + octets.byteLength);
  return rendu;
}
