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
// Rien n'est simulé et rien n'est passé sous silence. Sur un moteur sans OPFS synchrone dans le
// Worker — WebKit, que `docs/compatibility.md` classe déjà « refusé (OPFS absent) » — la suite
// n'est pas ignorée : elle EXIGE un refus typé `VAULT_STORAGE_UNSUPPORTED`. Un plantage non typé
// ou, pire, un succès, la ferait échouer. Sous Chromium, la capacité elle-même est exigée : c'est
// le moteur de `npm run check`, et l'y voir disparaître doit bloquer une PR.

/**
 * Le banc formate ses échecs « CODE — texte », et Playwright préfixe le tout de
 * « page.evaluate: Error: ». Le code reste donc le premier jeton `VAULT_STORAGE_*` du message.
 * Rendre `null` plutôt qu'une chaîne vide quand il n'y en a pas : un refus sans code typé doit
 * faire échouer l'assertion, pas ressembler à un code.
 */
function codeDuRefus(error) {
  const trouve = String(error?.message ?? "").match(/VAULT_STORAGE_[A-Z_]+/);
  return trouve ? trouve[0] : null;
}

async function ouvrirBanc(page) {
  await page.goto("/vm/opfs.html");
  await expect(page.locator("#etat")).toHaveText("Worker OPFS prêt.");
}

function executer(page, payload) {
  return page.evaluate((options) => globalThis.bancOpfs.executer(options), payload);
}

/** Exécute un scénario et rend soit son rapport, soit le code du refus typé. Jamais les deux. */
async function executerOuRefus(page, payload) {
  try {
    return { report: await executer(page, payload), code: null };
  } catch (error) {
    return { report: null, code: codeDuRefus(error) };
  }
}

/** Ouvre le banc et mesure ce que le moteur offre au Worker. */
async function contexte(page, testInfo) {
  await ouvrirBanc(page);
  const capacite = await executer(page, { scenario: "capacite" });
  await testInfo.attach(`opfs-capacite-${testInfo.project.name}.json`, {
    body: JSON.stringify(capacite, null, 2),
    contentType: "application/json",
  });
  const porte =
    capacite.workerGetDirectory === "function" &&
    capacite.workerCreateSyncAccessHandle === "function" &&
    capacite.openCode === null;
  return { capacite, porte };
}

test("le moteur porte OPFS synchrone dans un Worker, ou le refuse par une erreur typée", async ({
  page,
}, testInfo) => {
  const { capacite, porte } = await contexte(page, testInfo);

  if (testInfo.project.name === "chromium") {
    // Chromium est le moteur du contrôle obligatoire : perdre la capacité doit bloquer une PR,
    // pas basculer la suite en mesure négative.
    expect(capacite.workerGetDirectory).toBe("function");
    expect(capacite.workerCreateSyncAccessHandle).toBe("function");
    expect(capacite.openCode).toBeNull();
  }

  if (!porte) {
    expect(capacite.openCode).toBe(STORAGE_ERROR_CODES.unsupported);
    expect(capacite.openMessage).toBeTruthy();
  }
});

test("la page ne peut pas obtenir de handle OPFS synchrone", async ({ page }, testInfo) => {
  await ouvrirBanc(page);
  const sonde = await page.evaluate(() => globalThis.bancOpfs.sondePage());
  await testInfo.attach("opfs-sonde-page.json", {
    body: JSON.stringify(sonde, null, 2),
    contentType: "application/json",
  });

  // `openOpfsSyncAccess` refuse hors Worker dédié, sur TOUT moteur et avant même de regarder si
  // OPFS existe : la coquille, et donc la VM qu'elle encadre, n'a aucun chemin vers un handle
  // exclusif. Un succès ici serait une régression de SEC-ORIGIN.
  expect(sonde.code).toBe(STORAGE_ERROR_CODES.unsupported);
  expect(sonde.message).toContain("Worker");
  expect(sonde.opened).toBe(false);
});

test("un Worker dédié écrit, ferme, rouvre et relit le volume octet pour octet", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  const resultat = await executerOuRefus(page, { scenario: "persistance" });
  await testInfo.attach("opfs-persistance.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(resultat.code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }

  const rapport = resultat.report;
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
  const { porte } = await contexte(page, testInfo);
  const resultat = await executerOuRefus(page, { scenario: "exclusivite" });
  await testInfo.attach("opfs-exclusivite.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(resultat.code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }

  const rapport = resultat.report;
  expect(rapport.secondVolumeCode).toBe(STORAGE_ERROR_CODES.busy);
  expect(rapport.secondHandleCode).toBe(STORAGE_ERROR_CODES.busy);
  expect(rapport.afterCloseSize).toBe(PROBE_VOLUME_BYTES);
  expect(rapport.closedVolumeCode).toBe(STORAGE_ERROR_CODES.closed);
});

test("l'adaptateur v86 lit et écrit à travers le backend OPFS sans exposer de handle", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  const resultat = await executerOuRefus(page, { scenario: "adaptateur" });
  await testInfo.attach("opfs-adaptateur.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(resultat.code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }

  // Le contrat de tampon de v86 — `byteLength`, `load`, `get`, `set`, plus la barrière posée par le
  // pont de #4 — fonctionne tel quel au-dessus du support durable.
  const rapport = resultat.report;
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
