import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { REPOSITORY_ROOT } from "../../tools/v86-paths.mjs";

// Mesure du premier boot dans le navigateur, environnement qui compte pour
// `docs/quality-attributes.md`. Le protocole Node (`npm run vm:protocol`) mesure la même chose hors
// navigateur ; l'écart entre les deux est lui-même un résultat.
//
// Ce fichier MESURE, il n'arbitre presque rien : le seul seuil affirmé est le budget explicite de
// `docs/quality-attributes.md` (p95 ≤ 15 min). Transformer une durée observée en assertion serrée
// rendrait la suite instable sans rien prouver de plus.

const ECHAUFFEMENT = 1;
const ESSAIS = 5;
const BUDGET_P95_MS = 15 * 60 * 1000;

function percentile(valeurs, ratio) {
  const triees = [...valeurs].sort((a, b) => a - b);
  const index = Math.min(triees.length - 1, Math.ceil(ratio * triees.length) - 1);
  return triees[Math.max(0, index)];
}

test("premier boot : p50 et p95 sur cinq essais après échauffement", async ({ page }, testInfo) => {
  testInfo.setTimeout(600000);
  await page.goto("/vm/");
  await expect(page.locator("#etat")).toHaveText("Worker runtime prêt.");

  const durees = [];
  let dernier = null;
  for (let essai = 0; essai < ECHAUFFEMENT + ESSAIS; essai += 1) {
    dernier = await page.evaluate(() =>
      globalThis.bancVault.executer({ scenario: "barrier", durability: true }),
    );
    if (essai >= ECHAUFFEMENT) durees.push(dernier.bootMilliseconds);
  }

  const memoire = await page.evaluate(() => globalThis.bancVault.memoire());
  const mesures = {
    moteur: testInfo.project.name,
    navigateur: await page.evaluate(() => navigator.userAgent),
    crossOriginIsolated: dernier.crossOriginIsolated,
    octetsTransferes: dernier.transferredBytes,
    echauffement: ECHAUFFEMENT,
    essais: ESSAIS,
    dureesMs: durees,
    p50Ms: percentile(durees, 0.5),
    p95Ms: percentile(durees, 0.95),
    memoire,
  };
  const corps = `${JSON.stringify(mesures, null, 2)}\n`;
  await testInfo.attach("premier-boot.json", { body: corps, contentType: "application/json" });
  // Le même relevé est écrit sur disque, comme `reports/compat/` : un rapport Playwright n'est pas
  // un endroit où l'on retrouve une mesure six mois plus tard.
  const dossier = join(REPOSITORY_ROOT, "reports", "vm");
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, `premier-boot-${testInfo.project.name}.json`), corps);

  expect(durees).toHaveLength(ESSAIS);
  expect(mesures.p95Ms).toBeLessThan(BUDGET_P95_MS);
  // `performance.memory` n'existe que sous Chromium ; son absence est enregistrée, pas contournée.
  expect(memoire === null || typeof memoire.usedJSHeapSize === "number").toBe(true);
});
