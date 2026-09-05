// Témoin « le guest démarre et écrit » sur les TROIS moteurs de la matrice #2, sous la CSP servie
// par la coquille (`worker-src 'self'`, inchangée — ADR 0013).
//
// C'est la ligne que `docs/compatibility.md` portait à « non mesuré » puis à « seul Chromium fait
// battre le runtime » : elle passe ici à une mesure, moteur par moteur, avec le compte rendu du
// Worker runtime LIVRÉ — pas d'un banc parallèle. Le harnais de mesure de l'ADR 0013
// (`npm run test:csp`) répondait à « sous quelle CSP » ; celui-ci répond à « le produit démarre-t-il
// vraiment, avec sa boucle d'ordonnancement et son contrôle préalable ».
//
// Ce que le scénario `barrier` prouve, et qu'un simple « la page charge » ne prouverait pas : le
// guest boote jusqu'à son invite, écrit sur un disque IDE adossé au backend de Vault, et sa barrière
// de durabilité traverse le backend dans l'ordre. Il n'exige AUCUN OPFS, ce qui permet de le mesurer
// aussi sur WebKit, dont le refus d'OPFS est un fait indépendant (`VAULT_STORAGE_UNSUPPORTED`).
//
// Un moteur qui échoue ici produit un rapport et fait rougir la suite : c'est un fait de
// compatibilité qu'il faut voir, pas un écart à consigner en silence.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { REPOSITORY_ROOT, artefactsV86Absents } from "../../tools/v86-paths.mjs";

const ARTEFACTS = ["libv86.mjs", "v86.wasm", "seabios.bin", "vgabios.bin", "linux4.iso"];

test.beforeAll(() => {
  const absents = artefactsV86Absents(ARTEFACTS);
  if (absents.length > 0) {
    throw new Error(
      `Artefacts v86 absents (${absents.join(", ")}). Exécuter « npm run vm:fetch » avant « npm run test:vm ».`,
    );
  }
});

test("le guest démarre et écrit depuis le Worker runtime, sous la CSP servie", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(300_000);
  await page.goto("/vm/");
  await expect(page.locator("#etat")).toHaveText("Worker runtime prêt.");

  const debut = Date.now();
  const rapport = await page.evaluate(() =>
    globalThis.bancVault.executer({ scenario: "barrier", mode: "full" }),
  );
  const releve = {
    moteur: testInfo.project.name,
    mesureLe: new Date().toISOString(),
    navigateur: await page.evaluate(() => navigator.userAgent),
    dureeTotaleMs: Date.now() - debut,
    bootMs: rapport.bootMilliseconds,
    rythme: rapport.rythme,
    boucleOrdonnancement: rapport.boucleOrdonnancement,
    counts: rapport.counts,
    verdict: rapport.verdict,
    observationsRuntime: rapport.observationsRuntime,
    failures: rapport.failures,
  };
  const corps = `${JSON.stringify(releve, null, 2)}\n`;
  await testInfo.attach(`boot-trois-moteurs-${testInfo.project.name}.json`, {
    body: corps,
    contentType: "application/json",
  });
  const dossier = join(REPOSITORY_ROOT, "reports", "vm");
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, `boot-trois-moteurs-${testInfo.project.name}.json`), corps);

  // La boucle d'ordonnancement est celle de Vault, et v86 l'a réellement EMPRUNTÉE. Les deux faits
  // sont distincts : poser la boucle ne prouve pas que v86 la prenne — il fige son chemin à
  // l'évaluation de son module, sur `location.href`.
  expect(rapport.boucleOrdonnancement.source).toMatch(/^vault/);
  expect(rapport.boucleOrdonnancement.appels).toBeGreaterThan(0);

  // L'émulateur a battu : le compteur de tours de v86 a dépassé le tour unique d'un émulateur
  // construit puis abandonné, qui est la signature d'une boucle absente (ADR 0013).
  expect(rapport.rythme.ticks).toBeGreaterThan(1);
  expect(rapport.observationsRuntime).toEqual([]);

  // Le guest a démarré ET écrit, et sa barrière a traversé le backend dans l'ordre.
  expect(rapport.counts.write ?? 0).toBeGreaterThan(0);
  expect(rapport.verdict.satisfied).toBe(true);
  expect(rapport.verdict.reason).toBeNull();
  expect(rapport.failures).toEqual([]);
});
