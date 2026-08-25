import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import {
  MAX_SIDECAR_BYTES,
  openVolumeForWrite,
  readVolumeManifest,
} from "../../src/vm/opfs-volume-open.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";

// Preuve unitaire de l'OUVREUR EN ÉCRITURE (#12, `SEC-UPDATE-001`).
//
// `assertVolumeWritable` (#10) existait depuis le manifeste, mais aucun chemin de production ne
// l'appelait : la règle « jamais d'écriture sur un support non identifié » était écrite dans les
// documents et absente du code. Ce module est le point de passage unique qui la rend vraie, et ces
// épreuves vérifient qu'il refuse AVANT d'ouvrir quoi que ce soit — pas après.
//
// Les primitives de support sont injectées : sous Node il n'y a ni OPFS ni Worker dédié. Le vrai
// support est éprouvé au niveau Bout en bout, où le voisin d'un volume restauré est retiré et le
// boot suivant refusé.

const TAILLE = 8 * SECTOR_SIZE;

function manifesteValide(surcharge = {}) {
  return createManifest({
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app: { id: "railsbox-vault-reference", version: "1.0.0" },
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    ...surcharge,
  });
}

const attentes = {
  app: { id: "railsbox-vault-reference" },
  runtime: { version: "0.1.0" },
};

/**
 * Support injecté : une table de fichiers en mémoire. `ouvertures` compte les ouvertures de volume
 * RÉELLEMENT tentées — c'est la mesure qui distingue « refusé » de « refusé après coup ».
 */
function support({ fichiers = new Map() } = {}) {
  const journal = { ouvertures: [], stats: [] };
  return {
    journal,
    fichiers,
    stat(nom) {
      journal.stats.push(nom);
      const octets = fichiers.get(nom);
      return Promise.resolve(
        octets === undefined
          ? { present: false, size: 0 }
          : { present: true, size: octets.byteLength },
      );
    },
    lire(nom, taille) {
      return Promise.resolve(fichiers.get(nom).subarray(0, taille));
    },
    ecrire(nom, octets) {
      fichiers.set(nom, octets);
      return Promise.resolve();
    },
    ouvrir({ name, size }) {
      journal.ouvertures.push(name);
      return Promise.resolve({ name, size: () => size ?? TAILLE, close: () => Promise.resolve() });
    },
  };
}

test("un volume sans manifeste voisin n'est JAMAIS ouvert en écriture", async () => {
  const s = support();

  await assert.rejects(
    () =>
      openVolumeForWrite({
        name: "vault-app",
        expectations: attentes,
        stat: s.stat,
        readFile: s.lire,
        openVolume: s.ouvrir,
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.unidentified),
  );

  assert.deepEqual(s.journal.ouvertures, [], "le refus précède l'ouverture, il ne la suit pas");
});

test("un volume dont le manifeste est valide et compatible est ouvert", async () => {
  const s = support();
  await s.ecrire("vault-app.manifest", serializeManifest(manifesteValide()));

  const backend = await openVolumeForWrite({
    name: "vault-app",
    size: TAILLE,
    expectations: attentes,
    stat: s.stat,
    readFile: s.lire,
    openVolume: s.ouvrir,
  });

  assert.equal(backend.name, "vault-app");
  assert.deepEqual(s.journal.ouvertures, ["vault-app"]);
});

test("un manifeste d'une autre application refuse l'ouverture en écriture", async () => {
  const s = support();
  await s.ecrire(
    "vault-app.manifest",
    serializeManifest(manifesteValide({ app: { id: "railsbox/autre", version: "1.0.0" } })),
  );

  await assert.rejects(
    () =>
      openVolumeForWrite({
        name: "vault-app",
        expectations: attentes,
        stat: s.stat,
        readFile: s.lire,
        openVolume: s.ouvrir,
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.identityMismatch),
  );
  assert.deepEqual(s.journal.ouvertures, []);
});

test("un voisin illisible refuse l'ouverture au lieu d'être ignoré", async () => {
  const s = support();
  await s.ecrire("vault-app.manifest", new TextEncoder().encode("ceci n'est pas un manifeste"));

  await assert.rejects(
    () =>
      openVolumeForWrite({
        name: "vault-app",
        expectations: attentes,
        stat: s.stat,
        readFile: s.lire,
        openVolume: s.ouvrir,
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.malformed),
  );
  assert.deepEqual(s.journal.ouvertures, []);
});

test("un voisin démesuré est refusé sans être chargé en mémoire", async () => {
  const s = support();
  // Le support annonce un voisin de plusieurs Gio : le lire allouerait autant. La surmémoire de
  // streaming est bornée, y compris pour poser une question au support.
  const enorme = MAX_SIDECAR_BYTES + 1;
  const lectures = [];
  const stat = () => Promise.resolve({ present: true, size: enorme });
  const readFile = (nom, taille) => {
    lectures.push(taille);
    return Promise.resolve(new Uint8Array(taille));
  };

  await assert.rejects(
    () =>
      openVolumeForWrite({
        name: "vault-app",
        expectations: attentes,
        stat,
        readFile,
        openVolume: s.ouvrir,
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.malformed),
  );
  assert.deepEqual(lectures, [], "aucun octet n'est lu d'un voisin démesuré");
  assert.deepEqual(s.journal.ouvertures, []);
});

test("readVolumeManifest rend les OCTETS du voisin, ou null quand il n'y en a pas", async () => {
  const s = support();
  assert.equal(await readVolumeManifest("vault-app", { stat: s.stat, readFile: s.lire }), null);

  await s.ecrire("vault-app.manifest", serializeManifest(manifesteValide()));
  const octets = await readVolumeManifest("vault-app", { stat: s.stat, readFile: s.lire });
  assert.deepEqual(octets, serializeManifest(manifesteValide()));
});
