// La MISE À JOUR d'une application, jouée de bout en bout sur la coquille réelle (#236 T2, ADR 0042).
//
// Un coffre naît sous la version 1.0.0, reçoit une note et une pièce jointe, puis l'origine publie
// 1.1.0 — deux migrations, une colonne ajoutée — en gardant 1.0.0 servable (rétention 1). Ce que le
// scénario exige, dans l'ordre :
//
//  1. rouvrir : le bloc « Mettre à jour l'application » est proposé à l'accueil, AVANT tout boot ;
//     « Plus tard » laisse l'accueil tel quel, et le coffre s'ouvre en 1.0.0 (la colonne n'existe pas) ;
//  2. rouvrir : « Sauvegarder d'abord » rend une archive ; « Mettre à jour » boote 1.1.0, joue les
//     migrations, fait suivre le manifeste ; la note et sa pièce sont relues, la colonne est là ;
//  3. rouvrir après la page fermée : plus rien à proposer, aucune migration rejouée, données relues ;
//  4. l'origine revient à 1.0.0 seul : REFUS `APPLICATION_ANTERIEURE`, sans boot ;
//     une origine qui sert une autre application : `APPLICATION_ETRANGERE` ;
//     une origine qui ne sert rien : `APPLICATION_NON_SERVIE` ;
//  5. la sauvegarde faite AVANT la mise à jour se restaure sur une origine qui sert 1.0.0, et s'y
//     ouvre : la note y est relue, sans la colonne.
//
// Les descripteurs sont servis par INTERCEPTION du contexte (`context.route`) : c'est ce que ferait
// une origine qui publie, et aucun fichier partagé avec les autres scénarios n'est touché. Le Worker
// de confiance lit le descripteur par `fetch` ; l'interception l'atteint (mesuré sous Chromium).
//
// La coupure PENDANT la mise à jour — entre deux migrations — est prouvée sur l'image réelle par
// `tests/vm/migration-coupee.test.mjs` (`npm run test:vm:reference`), où l'arrêt de la machine se
// place à l'octet près ; ici, la coquille et ses gestes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE, E2E_ORIGIN_COQUILLE_B } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

const PHRASE = "une phrase de mise a jour assez longue pour la calibration argon";
const LIBELLE = "note écrite sous 1.0.0, relue après la mise à jour";
const PIECE = Buffer.from(Array.from({ length: 32 * 1024 }, (_, index) => (index * 31 + 7) % 253));
const PIECE_SHA256 = createHash("sha256").update(PIECE).digest("hex");

const BUDGET_DEMARRAGE_MS = 600_000;
/** Une mise à jour charge Rails deux fois : migrations, puis service. */
const BUDGET_MISE_A_JOUR_MS = 1_200_000;
const BUDGET_DEVERROUILLAGE_MS = 120_000;
const BUDGET_PREMIERE_PAGE_MS = 180_000;
const BUDGET_PORTABILITE_MS = 600_000;
/** Un refus de déphasage est décidé avant tout boot : il arrive en secondes. */
const BUDGET_REFUS_MS = 60_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  if (manifeste.precedent === undefined) {
    return "le manifeste ne porte aucun paquet précédent (rétention 1) : « npm run image:build »";
  }
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image absents (${absents.join(", ")}) : « npm run image:build »`;
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

/**
 * Les DESCRIPTEURS que les origines de ce scénario servent, dérivés de ceux que la fabrication a
 * écrits : rien n'est inventé, tout est relu du manifeste d'image.
 */
function descripteurs() {
  const complet = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const artefact = (nom) => manifeste.artifacts.find((candidat) => candidat.name === nom);
  const graineServie = artefact(manifeste.precedent.servis.graine);
  const graineImage = artefact(manifeste.precedent.graine);
  const { precedent, ...sansPrecedent } = complet;
  return {
    complet,
    // L'origine d'AVANT : 1.0.0 seul, sa graine, rien de précédent.
    seul100: {
      ...sansPrecedent,
      application: { id: complet.application.id, ...precedent.application },
      paquet: precedent.paquet,
      graine: {
        nom: graineServie.name,
        octets: graineImage.byteSize,
        sha256: graineImage.sha256,
        compression: "gzip",
        transfertOctets: graineServie.byteSize,
        disqueOctets: complet.graine.disqueOctets,
      },
    },
    autre: {
      ...sansPrecedent,
      application: { ...complet.application, id: "une-autre-application" },
    },
  };
}

/** SERT un descripteur à une origine — ou rien (404) — en interceptant le contexte. */
async function servirLeDescripteur(contexte, origine, descripteur) {
  const motif = `${origine}/artifacts/application.json`;
  await contexte.unroute(motif).catch(() => {});
  await contexte.route(motif, (route) =>
    descripteur === null
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "cache-control": "no-store" },
          body: JSON.stringify(descripteur),
        }),
  );
}

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());
const pageServie = (page) =>
  page.frameLocator("#document-applicatif").frameLocator("#application-servie");

async function ouvrirLaCoquille(contexte, origine, erreurs) {
  const page = await contexte.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${origine}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60_000 });
  return page;
}

async function attendreLEtat(page, etat, budget) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: budget }).toBe(etat);
}

async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await attendreLEtat(page, "ouvert", BUDGET_DEVERROUILLAGE_MS);
}

/** Attend le verdict d'un démarrage, quel qu'il soit, et rend la ligne d'état. */
async function verdictDuDemarrage(page, budget) {
  await expect(page.locator("#cycle-etat")).toHaveText(
    /^cycle:(application-demarree|demarrage-refuse)/,
    { timeout: budget },
  );
  return page.locator("#cycle-etat").textContent();
}

async function demarrer(page) {
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  return (await releve(page)).application;
}

/** Le constat de déphasage que la page a reçu du Worker, après le déverrouillage. */
async function dephasage(page) {
  await expect
    .poll(async () => (await releve(page)).dephasage?.issue ?? null, { timeout: 60_000 })
    .not.toBeNull();
  return (await releve(page)).dephasage;
}

/** Ouvre la note dans la page servie et rend ce qui s'y lit. */
async function relireLaNote(page, identifiant) {
  const servie = pageServie(page);
  await expect(servie.locator("body")).toHaveAttribute("data-application-de-reference", "rendue", {
    timeout: BUDGET_PREMIERE_PAGE_MS,
  });
  await expect(servie.locator(`[data-note="${identifiant}"]`)).toHaveText(LIBELLE, {
    timeout: 120_000,
  });
  await servie.locator(`[data-note="${identifiant}"]`).click();
  await expect(servie.locator("#piece-note")).toHaveAttribute("data-piece-sha256", PIECE_SHA256, {
    timeout: 120_000,
  });
  return {
    colonne: await servie.locator("#commentaire-note").count(),
    commentaire:
      (await servie.locator("#commentaire-note").count()) === 0
        ? null
        : (await servie.locator("#commentaire-note").textContent()).trim(),
  };
}

/** Un REFUS de déphasage : constaté à l'ouverture, redit au démarrage, sans boot. */
async function exigerLeRefus(page, code) {
  const constat = await dephasage(page);
  expect(constat.issue).toBe("refus");
  expect(constat.code).toBe(code);
  await expect(page.locator("#cycle-etat")).toHaveText(`cycle:application-refusee:${code}`);
  await expect(page.locator("#mise-a-jour")).toBeHidden();
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_REFUS_MS)).toBe(`cycle:demarrage-refuse:${code}`);
  const application = (await releve(page)).application;
  expect(application.demarree).toBe(false);
  expect(application.bootMs, "aucun boot n'a eu lieu").toBeUndefined();
}

test("un coffre 1.0.0 se met à jour en 1.1.0 sans rien perdre ; « Plus tard », le retour arrière et les origines étrangères sont tenus", async ({
  context,
  chronologie,
}, testInfo) => {
  exigerLesPrealables(raison, "mise-a-jour-du-paquet.spec.mjs");
  test.setTimeout(4_800_000);
  const erreurs = [];
  const mesures = {};
  const { complet, seul100, autre } = descripteurs();
  const noter = (etape, detail = {}) => chronologie.etape(etape, detail);

  // --- 1. Sous 1.0.0 : créer le coffre, sa feuille, installer, écrire une note et une pièce ------
  await servirLeDescripteur(context, E2E_ORIGIN_COQUILLE, seul100);
  noter("coffre-100");
  let page = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
  await ouvrirParLaPhrase(page);
  await page.click("#creer-recuperation");
  await expect(page.locator("#feuille-code")).not.toBeEmpty({ timeout: 60_000 });
  const code = (await page.locator("#feuille-code").textContent()).trim();
  const version = (await page.locator("#feuille-version").textContent()).match(/\d+/)[0];
  expect((await dephasage(page)).issue).toBe("installer");
  const installation = await demarrer(page);
  expect(installation.installation.installee).toBe(true);
  mesures.installation100 = { bootMs: installation.bootMs };
  const servie = pageServie(page);
  await expect(servie.locator("body")).toHaveAttribute("data-application-de-reference", "rendue", {
    timeout: BUDGET_PREMIERE_PAGE_MS,
  });
  await servie.locator("#libelle").fill(LIBELLE);
  await servie
    .locator("#piece")
    .setInputFiles({ name: "piece.bin", mimeType: "application/octet-stream", buffer: PIECE });
  await servie.locator("#enregistrer").click();
  await expect(servie.locator("#libelle-note")).toHaveText(LIBELLE, { timeout: 120_000 });
  const identifiant = (await servie.locator("#identifiant-note").textContent()).trim();
  noter("note-ecrite-sous-100", { identifiant });
  await page.close();

  // --- 2. L'origine publie 1.1.0 : la mise à jour est PROPOSÉE ; « Plus tard » ouvre 1.0.0 ------
  await servirLeDescripteur(context, E2E_ORIGIN_COQUILLE, complet);
  noter("reouverture-plus-tard");
  page = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
  await ouvrirParLaPhrase(page);
  let constat = await dephasage(page);
  expect(constat).toMatchObject({ issue: "mettre-a-jour", migration: true, plusTard: true });
  expect(constat.coffre.version).toBe(seul100.application.version);
  expect(constat.servie.version).toBe(complet.application.version);
  await expect(page.locator("#mise-a-jour")).toBeVisible();
  await expect(page.locator("#mise-a-jour-texte")).toContainText(complet.application.version);
  await expect(page.locator("#plus-tard")).toBeVisible();
  expect((await releve(page)).application, "rien n'a démarré à l'ouverture").toBeUndefined();
  await page.click("#plus-tard");
  await expect(page.locator("#mise-a-jour")).toBeHidden();
  const plusTard = await demarrer(page);
  expect(plusTard.miseAJour).toMatchObject({ issue: "mettre-a-jour", geste: false });
  expect(plusTard.miseAJour.migrationJouee).toBe(false);
  const sous100 = await relireLaNote(page, identifiant);
  expect(sous100.colonne, "« Plus tard » a ouvert le code 1.0.0 : pas de colonne").toBe(0);
  noter("plus-tard-ouvre-100");
  await page.close();

  // --- 3. Sauvegarder d'abord, puis METTRE À JOUR -------------------------------------------------
  noter("reouverture-mise-a-jour");
  page = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
  await ouvrirParLaPhrase(page);
  expect((await dephasage(page)).issue).toBe("mettre-a-jour");
  const telechargement = page.waitForEvent("download", { timeout: BUDGET_PORTABILITE_MS });
  await page.click("#sauvegarder-avant-mise-a-jour");
  const fichier = await telechargement;
  await expect(page.locator("#portabilite-etat")).toContainText("portabilite:sauvegarde-prete", {
    timeout: BUDGET_PORTABILITE_MS,
  });
  const archive = testInfo.outputPath("coffre-avant-mise-a-jour.rbvault");
  await fichier.saveAs(archive);
  noter("sauvegarde-avant-mise-a-jour");
  const debutMiseAJour = Date.now();
  await page.click("#mettre-a-jour-l-application");
  expect(await verdictDuDemarrage(page, BUDGET_MISE_A_JOUR_MS)).toBe("cycle:application-demarree");
  mesures.miseAJourMs = Date.now() - debutMiseAJour;
  const miseAJour = (await releve(page)).application;
  expect(miseAJour.miseAJour).toMatchObject({
    issue: "mettre-a-jour",
    geste: true,
    constatDuGuest: true,
    migrationJouee: true,
    migrationDe: seul100.application.schema,
    migrationVers: complet.application.schema,
    manifesteEcrit: true,
  });
  mesures.migrationMs = miseAJour.miseAJour.migrationMs;
  mesures.bootDeMiseAJourMs = miseAJour.bootMs;
  await expect(page.locator("#mise-a-jour-texte")).toContainText(complet.application.version);
  const sous110 = await relireLaNote(page, identifiant);
  expect(sous110).toEqual({ colonne: 1, commentaire: "(aucun commentaire)" });
  noter("mise-a-jour-faite", mesures);
  await page.close();

  // --- 4. Rouvrir APRÈS la mise à jour : rien à proposer, rien à rejouer --------------------------
  noter("reouverture-apres-mise-a-jour");
  page = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
  await ouvrirParLaPhrase(page);
  expect((await dephasage(page)).issue).toBe("ouvrir");
  await expect(page.locator("#mise-a-jour")).toBeHidden();
  const apres = await demarrer(page);
  expect(apres.installation.installee).toBe(false);
  expect(apres.miseAJour.migrationJouee).toBe(false);
  expect(apres.miseAJour.schemaDesDonnees).toBe(complet.application.schema);
  mesures.bootApresMiseAJourMs = apres.bootMs;
  expect(await relireLaNote(page, identifiant)).toEqual({
    colonne: 1,
    commentaire: "(aucun commentaire)",
  });
  await page.close();

  // --- 5. Les REFUS, avant tout boot --------------------------------------------------------------
  for (const [nom, descripteur, codeAttendu] of [
    ["retour-arriere", seul100, "VAULT_COQUILLE_APPLICATION_ANTERIEURE"],
    ["autre-application", autre, "VAULT_COQUILLE_APPLICATION_ETRANGERE"],
    ["origine-sans-application", null, "VAULT_COQUILLE_APPLICATION_NON_SERVIE"],
  ]) {
    noter(`refus-${nom}`);
    await servirLeDescripteur(context, E2E_ORIGIN_COQUILLE, descripteur);
    page = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
    await ouvrirParLaPhrase(page);
    await exigerLeRefus(page, codeAttendu);
    await page.close();
  }

  // --- 6. La sauvegarde d'AVANT se restaure sur une origine qui sert 1.0.0 -----------------------
  noter("restauration-sur-100");
  await servirLeDescripteur(context, E2E_ORIGIN_COQUILLE_B, seul100);
  const b = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE_B, erreurs);
  await b.setInputFiles("#archive-a-restaurer", archive);
  await b.click("#restaurer-le-coffre");
  await expect(b.locator("#portabilite-etat")).toContainText("portabilite:restauree", {
    timeout: BUDGET_PORTABILITE_MS,
  });
  await b.fill("#ancre-version", version);
  await b.fill("#saisie-code", code);
  await b.click("#ouvrir-par-code");
  await attendreLEtat(b, "ouvert", BUDGET_DEVERROUILLAGE_MS);
  expect((await dephasage(b)).issue).toBe("ouvrir");
  await demarrer(b);
  expect(await relireLaNote(b, identifiant), "la sauvegarde d'avant se rouvre en 1.0.0").toEqual({
    colonne: 0,
    commentaire: null,
  });
  await b.close();
  expect(erreurs, "aucune erreur de page").toEqual([]);

  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const rapport = { mesureLe: new Date().toISOString(), note: { identifiant }, mesures };
  writeFileSync(
    join(DOSSIER_RAPPORTS, "mise-a-jour-du-paquet.json"),
    `${JSON.stringify(rapport, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("mise-a-jour-du-paquet.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });
});
