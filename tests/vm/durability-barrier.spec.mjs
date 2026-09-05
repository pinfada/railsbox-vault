import { expect, test } from "@playwright/test";

import { auditDurabilityBarriers } from "../../src/vm/block-journal.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

// Preuve « intégration VM » du spike #4 : un vrai guest Linux i386 écrit sur un disque IDE dont le
// backend est celui de Vault, puis franchit une barrière de durabilité. La suite affirme deux
// choses opposées et complémentaires :
//
//  - SANS le pont, le guest ne demande jamais de barrière et le backend n'en voit aucune ;
//  - AVEC le pont, la barrière traverse le backend, dans l'ordre écriture → flush → acquittement.
//
// Le témoin négatif est indispensable : un test qui ne mesurerait que le cas corrigé ne prouverait
// pas que la correction sert à quelque chose.

const CACHE_TYPE_STEP = "cache-type";

test.beforeAll(() => {
  const missing = artefactsV86Absents([
    "libv86.mjs",
    "v86.wasm",
    "seabios.bin",
    "vgabios.bin",
    "linux4.iso",
  ]);
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

test("sans le pont, aucune barrière du guest n'atteint le backend", async ({ page }, testInfo) => {
  const rapport = await executer(page, { scenario: "barrier", mode: "observe" });
  await testInfo.attach("vm-amont.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  // Le noyau du guest classe le disque en écriture immédiate : il n'a donc aucune raison d'émettre
  // FLUSH CACHE, pas même sur `fsync`.
  expect(etape(rapport, CACHE_TYPE_STEP).output).toContain("write through");
  expect(rapport.counts.write ?? 0).toBeGreaterThan(0);
  expect(rapport.counts.flush ?? 0).toBe(0);
  expect(rapport.verdict.satisfied).toBe(false);
  expect(rapport.failures).toEqual([]);
});

test("avec le pont, l'écriture du guest est suivie d'une barrière acquittée", async ({
  page,
}, testInfo) => {
  const rapport = await executer(page, { scenario: "barrier", mode: "full" });
  await testInfo.attach("vm-pont.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  expect(etape(rapport, CACHE_TYPE_STEP).output).toContain("write back");

  const franchissement = etape(rapport, "write-then-flush");
  expect(franchissement.writes).toBeGreaterThan(0);
  expect(franchissement.flushes).toBeGreaterThan(0);
  expect(franchissement.flushAcks).toBe(franchissement.flushes);
  expect(franchissement.ata["0xE7"] ?? 0).toBeGreaterThan(0);

  // L'ordre est la propriété prouvée, pas le total : chaque barrière suit au moins une écriture et
  // précède son propre acquittement.
  expect(rapport.verdict.satisfied).toBe(true);
  expect(rapport.verdict.reason).toBeNull();
  for (const barriere of rapport.verdict.barriers) {
    expect(barriere.writesBefore).toBeGreaterThan(0);
    expect(barriere.ackSeq).toBeGreaterThan(barriere.flushSeq);
  }
  expect(rapport.failures).toEqual([]);
});

test("le verdict du rapport se rejoue hors du navigateur", async ({ page }) => {
  // Le même audit, appliqué côté Node aux barrières rapportées : la preuve ne dépend pas d'un
  // calcul fait dans la page.
  const rapport = await executer(page, { scenario: "barrier", mode: "full" });
  const rejoue = auditDurabilityBarriers(
    rapport.verdict.barriers.flatMap((barriere) => [
      { seq: barriere.flushSeq - 1, operation: "write", offset: 0, length: 512 },
      { seq: barriere.flushSeq, operation: "flush", barrier: barriere.flushSeq },
      { seq: barriere.ackSeq, operation: "flush-ack", barrier: barriere.flushSeq },
    ]),
  );
  expect(rejoue.satisfied).toBe(true);
});
