// SAUVEGARDER sur la coquille A, RESTAURER sur la coquille B, et Rails RELIT la mutation (#207,
// ADR 0039).
//
// ## Ce qu'il prouve, dans l'ordre où il le prouve
//
//  1. la coquille A s'ouvre par une phrase, crée son moyen de récupération, démarre Rails ; un
//     utilisateur SOUMET un formulaire dans la page servie — c'est la mutation ;
//  2. A SAUVEGARDE : l'application est arrêtée au point de contrôle, l'archive est écrite dans le
//     Worker de confiance et remise au NAVIGATEUR par un téléchargement — un fichier sur l'hôte ;
//  3. la coquille B — une AUTRE origine de confiance, un autre OPFS, son propre Service Worker de
//     cadre — RESTAURE ce fichier dans son emplacement vide ;
//  4. B s'ouvre par le CODE de récupération et la version notée, par le geste existant ;
//  5. B démarre Rails SANS réinstaller, et la page servie RELIT la note saisie dans A.
//
// ## Ce qu'il ne prouve PAS
//
//  - les refus (archive altérée, tronquée, emplacement occupé, coffre antérieur) : ils sont mesurés
//    sans machine virtuelle, sur trois moteurs, par `tests/browser/coquille-portabilite.spec.mjs` ;
//  - un autre moteur que Chromium, comme tous les scénarios de ce dossier.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import {
  E2E_ORIGIN_COQUILLE,
  E2E_ORIGIN_COQUILLE_APP,
  E2E_ORIGIN_COQUILLE_B,
  E2E_ORIGIN_COQUILLE_B_APP,
} from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** La PHRASE du scénario. Publique, sans valeur : elle ouvre un coffre que l'épreuve fabrique. */
const PHRASE = "une phrase de portabilite assez longue pour la calibration argon";
/** La MUTATION : ce que l'utilisateur tape dans A, et que B doit relire. */
const LIBELLE = "note saisie dans la coquille A, relue dans la coquille B";

const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_DEVERROUILLAGE_MS = 120_000;
const BUDGET_PREMIERE_PAGE_MS = 180_000;
/** Une archive d'un demi-gibioctet : deux passes d'empreinte à l'écriture, deux à la restauration. */
const BUDGET_PORTABILITE_MS = 600_000;
/**
 * L'attente qui laisse le noyau du guest écrire la fin de la transaction avant la sauvegarde. Le
 * noyau Linux vide ses métadonnées sales au plus tard après ~35 s (expiration 30 s, réveil 5 s) ;
 * 45 s laissent la marge. Voir l'écart nommé au § 2 du scénario.
 */
const ATTENTE_ECRITURE_DU_GUEST_MS = 45_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image #5 absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:manifest »`;
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());
const pageServie = (page) =>
  page.frameLocator("#document-applicatif").frameLocator("#application-servie");

async function ouvrirLaCoquille(contexte, origine, erreurs) {
  const page = await contexte.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${origine}/index.html`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60_000 });
  return page;
}

async function attendreLEtat(page, etat, budget) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: budget }).toBe(etat);
}

async function demarrerLApplication(page) {
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText(
    /^cycle:(application-demarree|demarrage-refuse)/,
    { timeout: BUDGET_DEMARRAGE_MS },
  );
  await expect(page.locator("#cycle-etat")).toHaveText("cycle:application-demarree");
  return (await releve(page)).application;
}

async function attendreLaPremierePage(page) {
  await expect(pageServie(page).locator("body")).toHaveAttribute(
    "data-application-de-reference",
    "rendue",
    { timeout: BUDGET_PREMIERE_PAGE_MS },
  );
}

test("une note saisie dans la coquille A se relit dans la coquille B, restaurée depuis la sauvegarde de A", async ({
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "portabilite-coquille.spec.mjs");
  test.setTimeout(2_400_000);
  const depart = Date.now();
  const mesures = {};
  const erreurs = [];

  // --- 1. A : ouvrir, créer la feuille, démarrer, ÉCRIRE -----------------------------------------
  const a = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
  expect((await releve(a)).origineApplicative).toBe(E2E_ORIGIN_COQUILLE_APP);
  await a.fill("#saisie-phrase", PHRASE);
  await a.click("#ouvrir-par-phrase");
  await attendreLEtat(a, "ouvert", BUDGET_DEVERROUILLAGE_MS);
  await a.click("#creer-recuperation");
  await expect(a.locator("#feuille-code")).not.toBeEmpty({ timeout: 60_000 });
  const code = (await a.locator("#feuille-code").textContent()).trim();
  const version = (await a.locator("#feuille-version").textContent()).match(/\d+/)[0];

  const demarrageA = await demarrerLApplication(a);
  expect(demarrageA.installation.installee).toBe(true);
  mesures.bootAMs = demarrageA.bootMs;
  await attendreLaPremierePage(a);
  const servieA = pageServie(a);
  await servieA.locator("#libelle").fill(LIBELLE);
  await servieA.locator("#enregistrer").click();
  await expect(servieA.locator("#libelle-note")).toHaveText(LIBELLE, { timeout: 120_000 });
  const identifiant = (await servieA.locator("#identifiant-note").textContent()).trim();
  expect(identifiant).toMatch(/^[0-9a-f-]{36}$/);

  // ÉCART NON COMBLÉ (#207, ADR 0039, limite 5) : Une écriture que Rails vient d'acquitter peut
  // manquer à une sauvegarde prise dans les secondes qui suivent : le point de contrôle arrête la VM
  // sans attendre que le noyau du guest ait écrit la fin de la transaction, et le scénario de bout
  // en bout attend 45 s avant de sauvegarder (mesuré le 13/09/2026 : rouge sans l'attente, vert
  // avec).
  // Sans elle, la note manque à B (exécution locale du 13/09/2026) ; l'écart est ouvert sous #209.
  await a.waitForTimeout(ATTENTE_ECRITURE_DU_GUEST_MS);
  mesures.attenteEcritureDuGuestMs = ATTENTE_ECRITURE_DU_GUEST_MS;
  // --- 2. A : SAUVEGARDER, au point de contrôle, vers un fichier de l'hôte -----------------------
  const departSauvegarde = Date.now();
  const telechargement = a.waitForEvent("download", { timeout: BUDGET_PORTABILITE_MS });
  await a.click("#sauvegarder-le-coffre");
  const fichier = await telechargement;
  await expect(a.locator("#portabilite-etat")).toContainText("portabilite:sauvegarde-prete", {
    timeout: BUDGET_PORTABILITE_MS,
  });
  const chemin = testInfo.outputPath("coffre-a.rbvault");
  await fichier.saveAs(chemin);
  mesures.sauvegardeMs = Date.now() - departSauvegarde;
  const sauvegarde = (await releve(a)).portabilite.sauvegarde;
  expect(sauvegarde.applicationArretee, "le point de contrôle arrête l'application").toBe(true);
  expect(sauvegarde.coherence.kind).toBe("handle-exclusif");
  expect(sauvegarde.recuperationEmportee).toBe(true);
  expect(statSync(chemin).size).toBe(sauvegarde.taille);
  await a.close();

  // --- 3. B : une AUTRE origine, RESTAURER dans l'emplacement vide --------------------------------
  const b = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE_B, erreurs);
  expect((await releve(b)).origineApplicative).toBe(E2E_ORIGIN_COQUILLE_B_APP);
  expect((await releve(b)).etat).toBe("verrouille");
  const departRestauration = Date.now();
  await b.setInputFiles("#archive-a-restaurer", chemin);
  await b.click("#restaurer-le-coffre");
  await expect(b.locator("#portabilite-etat")).toContainText("portabilite:restauree", {
    timeout: BUDGET_PORTABILITE_MS,
  });
  mesures.restaurationMs = Date.now() - departRestauration;
  const restauration = (await releve(b)).portabilite.restauration;
  expect(restauration.empreinte).toBe(sauvegarde.empreinte);
  expect(restauration.empreinteRelue).toBe(sauvegarde.empreinte);

  // --- 4. B : ouvrir par le CODE et la version notée ---------------------------------------------
  await b.fill("#ancre-version", version);
  await b.fill("#saisie-code", code);
  await b.click("#ouvrir-par-code");
  await attendreLEtat(b, "ouvert", BUDGET_DEVERROUILLAGE_MS);

  // --- 5. B : Rails démarre SANS réinstaller, et relit la note ------------------------------------
  const demarrageB = await demarrerLApplication(b);
  expect(demarrageB.installation.installee, "le disque restauré n'est pas réinstallé").toBe(false);
  mesures.bootBMs = demarrageB.bootMs;
  await attendreLaPremierePage(b);
  await expect(
    pageServie(b).locator(`[data-note="${identifiant}"]`),
    "la note saisie dans A n'a pas été relue dans B",
  ).toHaveText(LIBELLE, { timeout: 120_000 });
  expect(erreurs, "aucune erreur de page").toEqual([]);

  mesures.totalMs = Date.now() - depart;
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const rapport = {
    mesureLe: new Date().toISOString(),
    note: { identifiant, libelle: LIBELLE },
    sauvegarde,
    restauration,
    mesures,
  };
  writeFileSync(
    join(DOSSIER_RAPPORTS, "portabilite-coquille.json"),
    `${JSON.stringify(rapport, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("portabilite-coquille.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });
});
