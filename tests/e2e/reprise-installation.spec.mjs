// « REPRENDRE L'INSTALLATION », du CLIC réel jusqu'au BOOT complet de Rails (#197 ; #250).
//
// Ce que les épreuves légères ne pouvaient pas jouer : `tests/unit/coquille-installation-interrompue.test.mjs`
// prouve la reconnaissance et la reprise sur le double déterministe, `tests/browser/` la page et ses
// mots, sans machine virtuelle. Ici, l'image de référence est RÉELLE :
//
//  1. la GRAINE est refusée par l'origine (403, le cas de la recette QA de #249) : le premier
//     « Démarrer » rend l'installation interrompue, reconnue tout de suite, et le bouton apparaît ;
//  2. l'origine sert de nouveau la graine ; le CLIC sur « Reprendre l'installation » retire le volume
//     orphelin, réinstalle, et Rails démarre dans le Worker de confiance ;
//  3. la SECONDE garde d'ordre du geste destructeur, qu'aucune épreuve légère n'atteint : une reprise
//     demandée pendant que l'application TOURNE est refusée (`VAULT_COQUILLE_ETAPE_HORS_ORDRE`), et
//     l'application tourne encore ;
//  4. le coffre se verrouille.
//
// Le geste de l'étape 3 est invoqué sur le bouton CACHÉ (`element.click()`) : c'est l'attaque qu'il
// faut refuser — une page qui l'enverrait quand même —, pas un chemin que la page offre.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE } from "../../playwright.e2e.config.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const PHRASE = "une phrase de scenario assez longue pour la calibration";
const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_GESTE_MS = 120_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:build »`;
  }
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  if (descripteur.descripteurVersion !== 2 || descripteur.graine === undefined) {
    return "descripteur d'avant #236 (sans graine) : « npm run image:build »";
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

test("#197 : la graine refusée, puis le CLIC sur « Reprendre l'installation » jusqu'au boot de Rails", async ({
  context,
}) => {
  exigerLesPrealables(raison, "reprise-installation.spec.mjs");
  test.setTimeout(1_200_000);
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  const graine = { refusee: true };
  // Refusée tant que l'épreuve le dit, puis laissée à l'origine : c'est l'origine qui la sert.
  await context.route(`**${descripteur.prefixeDesArtefacts}${descripteur.graine.nom}`, (route) =>
    graine.refusee ? route.fulfill({ status: 403, body: "interdit" }) : route.continue(),
  );

  const page = await context.newPage();
  const erreurs = [];
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 60_000,
  });
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: BUDGET_GESTE_MS })
    .toBe("ouvert");

  // --- 1. La graine refusée : l'installation interrompue est reconnue DÈS le premier démarrage ----
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${C.volumeApplicatifSansManifeste}`,
    { timeout: BUDGET_GESTE_MS },
  );
  expect((await releve(page)).application.installationInterrompue).toBe(true);
  await expect(page.locator("#parcours-refus")).toContainText(
    "L'installation de votre application n'a pas pu se terminer.",
  );
  await expect(page.locator("#reprendre-l-installation")).toBeVisible();

  // --- 2. L'origine sert la graine : le CLIC réel reprend, et Rails démarre ----------------------
  graine.refusee = false;
  await page.click("#reprendre-l-installation");
  await expect(page.locator("#cycle-etat")).toHaveText("cycle:application-demarree", {
    timeout: BUDGET_DEMARRAGE_MS,
  });
  const demarree = (await releve(page)).application;
  expect(demarree.demarree).toBe(true);
  // C'est la REPRISE qui a réinstallé ; le démarrage qu'elle enchaîne trouve donc l'application en
  // place — `installee: false` est ici la preuve que le versement a abouti avant le boot.
  expect(demarree.installation.installee).toBe(false);
  expect(demarree.bootMs, "Rails a booté").toBeGreaterThan(0);
  await expect(page.locator("#reprendre-l-installation")).toBeHidden();

  // --- 3. La SECONDE garde d'ordre : pas de reprise sous une application qui tourne ---------------
  await page.evaluate(() => document.getElementById("reprendre-l-installation").click());
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:reprise-refusee:${C.etapeHorsOrdre}`,
    { timeout: BUDGET_GESTE_MS },
  );
  const toujours = await page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes");
    const fichier = await (await dossier.getFileHandle("application.manifest")).getFile();
    return fichier.size > 0;
  });
  expect(toujours, "le volume en service n'a pas été retiré").toBe(true);

  // --- 4. Le coffre se verrouille ------------------------------------------------------------------
  const recharge = page.waitForEvent("load", { timeout: BUDGET_GESTE_MS });
  await page.click("#verrouiller-le-coffre");
  await recharge;
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 60_000,
  });
  expect((await releve(page)).etat).toBe("verrouille");
  expect(erreurs, "aucune erreur de page").toEqual([]);
});
