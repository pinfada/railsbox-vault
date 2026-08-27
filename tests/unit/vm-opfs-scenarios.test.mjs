import assert from "node:assert/strict";
import test from "node:test";

import { digestHex } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import {
  PROBE_REGIONS,
  PROBE_VOLUME_BYTES,
  PROBE_VOLUME_DIGEST,
  auditPersistenceReport,
  buildProbeImage,
  observePersistence,
} from "../../src/vm/opfs-scenarios.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// La sonde de persistance est partagée : elle s'exécute ici sur le double déterministe, et dans
// `tests/browser/opfs-block-backend.spec.mjs` sur le vrai OPFS d'un Worker Chromium. Les deux
// couches doivent produire la MÊME empreinte de volume — sans quoi l'une des deux ment.

test("l'image attendue du volume est reconstruite depuis sa règle et pas depuis une constante", async () => {
  const image = await buildProbeImage();

  assert.equal(image.byteLength, PROBE_VOLUME_BYTES);
  assert.equal(await digestHex(image), PROBE_VOLUME_DIGEST);
});

test("chaque région de la sonde couvre un cas d'accès distinct", () => {
  const etiquettes = PROBE_REGIONS.map((region) => region.label);
  assert.deepEqual([...new Set(etiquettes)], etiquettes, "pas deux régions homonymes");

  const nonAlignee = PROBE_REGIONS.find((region) => region.offset % 512 !== 0);
  assert.ok(nonAlignee, "la sonde doit contenir une écriture non alignée sur le secteur");

  const finDeVolume = PROBE_REGIONS.find(
    (region) => region.offset + region.length === PROBE_VOLUME_BYTES,
  );
  assert.ok(finDeVolume, "la sonde doit écrire jusqu'au dernier octet du volume");
});

test("la sonde de persistance est satisfaite sur un support déterministe", async () => {
  const store = createSyncAccessStore();
  const rapport = await observePersistence({
    openVolume: (options) =>
      openOpfsVolume({ ...options, cle: CLE_DE_TEST, openHandle: store.openHandle }),
    name: "sonde",
  });

  const verdict = await auditPersistenceReport(rapport);
  assert.equal(verdict.reasons.join(" | "), "");
  assert.equal(verdict.satisfied, true);

  assert.equal(rapport.opened.size, PROBE_VOLUME_BYTES);
  assert.equal(rapport.reopened.size, PROBE_VOLUME_BYTES, "la géométrie survit à la réouverture");
  assert.equal(rapport.reopened.durable, true);
  assert.equal(rapport.wholeDigest, PROBE_VOLUME_DIGEST);
  assert.equal(rapport.outOfRange.code, STORAGE_ERROR_CODES.outOfRange);
  assert.equal(rapport.handleExposed, false, "aucun handle OPFS ne sort du backend");
});

test("le rapport de la sonde traverse postMessage sans perdre sa substance", async () => {
  const store = createSyncAccessStore();
  const rapport = await observePersistence({
    openVolume: (options) =>
      openOpfsVolume({ ...options, cle: CLE_DE_TEST, openHandle: store.openHandle }),
    name: "sonde-json",
  });

  const rejoue = JSON.parse(JSON.stringify(rapport));
  const verdict = await auditPersistenceReport(rejoue);
  assert.equal(verdict.satisfied, true);
});

test("l'audit rejette un rapport dont un seul octet a bougé", async () => {
  const store = createSyncAccessStore();
  const rapport = await observePersistence({
    openVolume: (options) =>
      openOpfsVolume({ ...options, cle: CLE_DE_TEST, openHandle: store.openHandle }),
    name: "sonde-corrompue",
  });

  const corrompu = { ...rapport, wholeDigest: `${rapport.wholeDigest.slice(0, -1)}0` };
  const verdict = await auditPersistenceReport(corrompu);
  assert.equal(verdict.satisfied, false);
  assert.match(verdict.reasons.join(" | "), /empreinte du volume/i);
});

test("l'audit rejette un rapport où la relecture hors bornes aurait réussi", async () => {
  const store = createSyncAccessStore();
  const rapport = await observePersistence({
    openVolume: (options) =>
      openOpfsVolume({ ...options, cle: CLE_DE_TEST, openHandle: store.openHandle }),
    name: "sonde-hors-bornes",
  });

  const verdict = await auditPersistenceReport({ ...rapport, outOfRange: { code: null } });
  assert.equal(verdict.satisfied, false);
  assert.match(verdict.reasons.join(" | "), /hors bornes/i);
});
