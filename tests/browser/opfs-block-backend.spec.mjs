import { expect, test } from "@playwright/test";

import {
  PROBE_VOLUME_BYTES,
  PROBE_VOLUME_DIGEST,
  auditPersistenceReport,
} from "../../src/vm/opfs-scenarios.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// Preuve de niveau NAVIGATEUR du backend de blocs OPFS (#6, `VAULT-PERSIST-001`). Elle exécute le
// vrai backend, sur le vrai OPFS, dans un Worker dédié — jamais dans la page, conformément à
// l'ADR 0002. La sonde exécutée est exactement celle que `tests/unit/vm-opfs-scenarios.test.mjs`
// rejoue sur un double déterministe : les deux couches doivent produire la même empreinte
// SHA-256 de volume, sans quoi l'une des deux ment.
//
// Rien n'est simulé ici : si `createSyncAccessHandle` manque au moteur, le Worker remonte une
// erreur typée et la suite échoue. Un moteur sans OPFS synchrone ne peut pas porter le produit.

async function ouvrirBanc(page) {
  await page.goto("/vm/opfs.html");
  await expect(page.locator("#etat")).toHaveText("Worker OPFS prêt.");
}

async function executer(page, payload) {
  return page.evaluate((options) => globalThis.bancOpfs.executer(options), payload);
}

test("la page ne peut pas obtenir de handle OPFS synchrone", async ({ page }, testInfo) => {
  await ouvrirBanc(page);
  const sonde = await page.evaluate(() => globalThis.bancOpfs.sondePage());
  await testInfo.attach("opfs-sonde-page.json", {
    body: JSON.stringify(sonde, null, 2),
    contentType: "application/json",
  });

  // `openOpfsSyncAccess` refuse hors Worker dédié : la coquille, et donc la VM qu'elle encadre,
  // n'a aucun chemin vers un handle exclusif. Un succès ici serait une régression de SEC-ORIGIN.
  expect(sonde.code).toBe(STORAGE_ERROR_CODES.unsupported);
  expect(sonde.message).toContain("Worker");
  expect(sonde.opened).toBe(false);
});

test("un Worker dédié écrit, ferme, rouvre et relit le volume octet pour octet", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const rapport = await executer(page, { scenario: "persistance" });
  await testInfo.attach("opfs-persistance.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  expect(rapport.support).toBe("opfs");
  expect(rapport.opened.size).toBe(PROBE_VOLUME_BYTES);
  expect(rapport.opened.durable).toBe(true);

  // La géométrie survit à la fermeture du handle et n'est jamais redécidée en silence.
  expect(rapport.reopened.size).toBe(PROBE_VOLUME_BYTES);
  expect(rapport.reopenedWithoutDeclaredSize).toBe(true);

  // L'empreinte du volume relu est celle de l'image attendue, reconstruite côté Node depuis sa
  // règle : la comparaison ne dépend d'aucun calcul fait dans le navigateur.
  expect(rapport.wholeDigest).toBe(PROBE_VOLUME_DIGEST);
  expect(rapport.outOfRange.code).toBe(STORAGE_ERROR_CODES.outOfRange);
  expect(rapport.handleExposed).toBe(false);

  const verdict = await auditPersistenceReport(rapport);
  expect(verdict.reasons).toEqual([]);
  expect(verdict.satisfied).toBe(true);
});

test("l'exclusivité du volume est refusée au second demandeur puis rendue à la fermeture", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const rapport = await executer(page, { scenario: "exclusivite" });
  await testInfo.attach("opfs-exclusivite.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  expect(rapport.secondVolumeCode).toBe(STORAGE_ERROR_CODES.busy);
  expect(rapport.secondHandleCode).toBe(STORAGE_ERROR_CODES.busy);
  expect(rapport.afterCloseSize).toBe(PROBE_VOLUME_BYTES);
  expect(rapport.closedVolumeCode).toBe(STORAGE_ERROR_CODES.closed);
});

test("l'adaptateur v86 lit et écrit à travers le backend OPFS sans exposer de handle", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const rapport = await executer(page, { scenario: "adaptateur" });
  await testInfo.attach("opfs-adaptateur.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  // Le contrat de tampon de v86 — `byteLength`, `load`, `get`, `set`, plus la barrière posée par le
  // pont de #4 — fonctionne tel quel au-dessus du support durable.
  expect(rapport.byteLength).toBe(PROBE_VOLUME_BYTES);
  expect(rapport.loaded).toBe(true);
  expect(rapport.setAcknowledged).toBe(true);
  expect(rapport.flushAcknowledged).toBe(true);
  expect(rapport.roundTripDigest).toBe(rapport.writtenDigest);
  expect(rapport.status.fatal).toBeNull();
  expect(rapport.status.inFlight).toBe(0);
  expect(rapport.persistedAfterReopen).toBe(true);

  // Aucune propriété de l'adaptateur ne porte un objet du système de fichiers : ce que v86 — et
  // donc le guest — peut atteindre s'arrête au contrat de tampon.
  expect(rapport.exposesFileSystemHandle).toBe(false);
  expect(rapport.getStateCode).toBe(STORAGE_ERROR_CODES.unsupported);
});
