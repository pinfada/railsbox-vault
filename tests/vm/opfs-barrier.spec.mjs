import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAULT_KINDS } from "../../src/vm/fault-plan.mjs";
import { ARTIFACT_DIRECTORY } from "../../tools/v86-paths.mjs";

// Preuve « intégration VM » de la barrière durable de bout en bout (#14, `SEC-DURABLE-001`,
// `VAULT-PERSIST-001`). Un vrai guest Linux i386 écrit puis `fsync` sur un disque IDE adossé au
// backend OPFS de production (#6), et la suite démontre trois choses que le niveau unitaire prouve
// de façon déterministe (`tests/unit/vm-durability-barrier.test.mjs`), rejouées ici sur le vrai
// support :
//
//  - l'ordre causal write → flush(OPFS réel) → acquittement, barrière par barrière ;
//  - le flush RETARDÉ : le guest reste occupé jusqu'à la résolution du flush, et son acquittement ne
//    précède jamais sa barrière ;
//  - le flush en ÉCHEC : la barrière échoue, le guest reçoit une erreur d'E/S, la coquille une
//    erreur typée, et AUCUN acquittement de durabilité n'est inventé.
//
// La persistance RPO 0 après une barrière acquittée (relecture après réouverture du handle) est
// prouvée par `tests/vm/opfs-persistence.spec.mjs` ; cette suite se concentre sur l'ORDRE et sur ce
// qui le briserait.

const CACHE_TYPE_STEP = "cache-type";
const BARRIER_STEP = "write-then-flush";

test.beforeAll(() => {
  const missing = ["libv86.mjs", "v86.wasm", "seabios.bin", "vgabios.bin", "linux4.iso"].filter(
    (name) => !existsSync(join(ARTIFACT_DIRECTORY, name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Artefacts v86 absents (${missing.join(", ")}). Exécuter « npm run vm:fetch » avant « npm run test:vm ».`,
    );
  }
});

async function executer(page, payload) {
  await page.goto("/vm/");
  await expect(page.locator("#etat")).toHaveText("Worker runtime prêt.");
  return page.evaluate((options) => globalThis.bancVault.executer(options), payload);
}

function etape(rapport, label) {
  const trouvee = rapport.steps.find((step) => step.label === label);
  if (!trouvee) throw new Error(`Étape « ${label} » absente du rapport.`);
  return trouvee;
}

test("le guest voit sa barrière franchir le backend OPFS, dans l'ordre, malgré un flush retardé", async ({
  page,
}, testInfo) => {
  // `flushDelay` retarde chaque barrière du support : si l'acquittement du guest précédait la
  // résolution du flush, l'ordre du journal serait inversé. Il ne doit jamais l'être.
  const rapport = await executer(page, { scenario: "opfs-barrier", flushDelay: 40 });
  await testInfo.attach("vm-opfs-barriere.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  expect(etape(rapport, CACHE_TYPE_STEP).output).toContain("write back");

  const franchissement = etape(rapport, BARRIER_STEP);
  expect(franchissement.writes).toBeGreaterThan(0);
  expect(franchissement.flushes).toBeGreaterThan(0);
  expect(franchissement.flushAcks).toBe(franchissement.flushes);
  expect(franchissement.ata["0xE7"] ?? 0).toBeGreaterThan(0);

  // L'ordre est la propriété prouvée : chaque barrière suit au moins une écriture et précède son
  // propre acquittement, sur le vrai OPFS et malgré la latence injectée.
  expect(rapport.verdict.satisfied).toBe(true);
  expect(rapport.verdict.reason).toBeNull();
  for (const barriere of rapport.verdict.barriers) {
    expect(barriere.writesBefore).toBeGreaterThan(0);
    expect(barriere.ackSeq).toBeGreaterThan(barriere.flushSeq);
  }
  expect(rapport.failures).toEqual([]);
});

test("un flush OPFS en échec abandonne la commande : le guest et la coquille le voient, rien n'est acquitté", async ({
  page,
}, testInfo) => {
  // Le support disparaît à la première barrière du guest. La faute est déterministe et persistante :
  // les tentatives du noyau ne la font pas disparaître.
  const rapport = await executer(page, {
    scenario: "opfs-barrier",
    fault: FAULT_KINDS.lostHandle,
  });
  await testInfo.attach("vm-opfs-barriere-echec.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  // Le guest a bien DEMANDÉ la barrière — la commande FLUSH CACHE est passée par le pont…
  expect(etape(rapport, BARRIER_STEP).ata["0xE7"] ?? 0).toBeGreaterThan(0);
  // …la faute a bien été déclenchée…
  expect(rapport.faultsFired.some((f) => f.kind === FAULT_KINDS.lostHandle)).toBe(true);
  // …la coquille observe une erreur TYPÉE (jamais l'erreur brute du support)…
  expect(rapport.failures.some((f) => f.code === "VAULT_STORAGE_HANDLE_LOST")).toBe(true);
  // …et AUCUN acquittement de durabilité n'a été inventé.
  expect(rapport.counts["flush-ack"] ?? 0).toBe(0);
  expect(rapport.verdict.satisfied).toBe(false);
});
