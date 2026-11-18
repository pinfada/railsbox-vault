// LA PREUVE du DÉMARRAGE HORS CONNEXION (#247, lot D1g ; ADR 0044 § 6, ADR 0046) : un coffre déjà
// démarré une fois, réseau coupé, démarre depuis la réserve sans télécharger un octet de l'image.
//
// Sur le modèle de `mise-a-jour-du-paquet.spec.mjs` : la coquille réelle, la vraie image, le vrai
// Worker de confiance. Ce que le scénario exige, dans l'ordre :
//
//  1. EN LIGNE, un premier démarrage : il télécharge, range les artefacts au magasin, puis range le
//     descripteur SCELLÉ — après l'acquisition complète, jamais avant ;
//  2. réseau COUPÉ (`context.setOffline`), la page déjà chargée et le coffre déverrouillé, « Démarrer » :
//     `fetch` du descripteur lève un `TypeError`, le descripteur rangé fait foi, l'application répond,
//     et AUCUNE réponse n'est servie pour le rootfs, le paquet, le noyau ni le wasm ;
//  3. CONTRE-ÉPREUVE, descripteur rangé ALTÉRÉ dans l'OPFS (un octet) : refus typé
//     `HORS_LIGNE_DESCRIPTEUR_REFUSE`, aucun boot ;
//  4. le démarrage EN LIGNE suivant le remplace par un descripteur sain ;
//  5. CONTRE-ÉPREUVES, l'origine RÉPOND — HTTP 500, puis du HTML de portail captif — : PAS de repli,
//     la décision de l'ADR 0042 (`APPLICATION_NON_SERVIE`) s'applique, quoi que la réserve contienne.
//
// La page n'est jamais rechargée hors connexion : sans Service Worker, le code de la coquille vient du
// cache HTTP ou du réseau, et ce n'est pas l'objet de cette tranche (ADR 0046, limite écrite).
//
// Ce que ce scénario ne prouve PAS : le retour arrière (rangé antérieur au volume) — il demande une
// mise à jour complète de l'image ; il est prouvé par `tests/unit/coquille-hors-connexion.test.mjs` et
// `coquille-demarrage-hors-connexion.test.mjs` (décision de déphasage réelle, descripteur rangé réel,
// sceau réel). Le descripteur fabriqué et celui d'un autre coffre sont prouvés par
// `tests/browser/descripteur-scelle.spec.mjs` sur les trois moteurs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");

const PHRASE = "une phrase de reseau coupe assez longue pour la calibration argon";
const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_DEVERROUILLAGE_MS = 120_000;
const BUDGET_REFUS_MS = 60_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:manifest »`;
  }
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  if (descripteur.boot?.empreintes === undefined) {
    return "le descripteur ne porte pas `boot.empreintes` (noyau, initrd, BIOS) : « npm run image:manifest »";
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

async function ouvrirLaCoquille(contexte, erreurs) {
  const page = await contexte.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html?vue=complete`, { waitUntil: "load" });
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

/** VERROUILLE : la coquille est rechargée — EN LIGNE — et l'on attend le document prêt. */
async function verrouiller(page) {
  const rechargement = page.waitForEvent("load", { timeout: 300_000 });
  await page.click("#verrouiller-le-coffre");
  await rechargement;
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 120_000,
  });
  await attendreLEtat(page, "verrouille", 60_000);
}

/** Le descripteur rangé, tel que l'OPFS de l'origine de confiance le garde : ses octets, ou `null`. */
const lireLeRange = (page) =>
  page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    try {
      const dossier = await racine.getDirectoryHandle("vault-artefacts");
      const fichier = await (await dossier.getFileHandle("descripteur.scelle")).getFile();
      return Array.from(new Uint8Array(await fichier.arrayBuffer()));
    } catch {
      return null;
    }
  });

/** ALTÈRE un octet du descripteur rangé — ce que ferait quelqu'un qui écrit dans l'OPFS sans la clé. */
const alterer = (page) =>
  page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-artefacts");
    const poignee = await dossier.getFileHandle("descripteur.scelle");
    const octets = new Uint8Array(await (await poignee.getFile()).arrayBuffer());
    octets[Math.floor(octets.byteLength / 2)] ^= 0x01;
    const flux = await poignee.createWritable();
    await flux.write(octets);
    await flux.close();
  });

/** Un démarrage qui doit être REFUSÉ, sans boot, avec ce code. */
async function exigerLeRefusAuDemarrage(page, code) {
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_REFUS_MS)).toBe(`cycle:demarrage-refuse:${code}`);
  const application = (await releve(page)).application;
  expect(application.demarree).toBe(false);
  expect(application.bootMs, "aucun boot n'a eu lieu").toBeUndefined();
  expect(application.horsConnexion ?? null, "aucun repli hors connexion").toBeNull();
}

test("un coffre déjà démarré redémarre réseau coupé, depuis la réserve ; un descripteur altéré ou une origine qui répond mal n'ouvrent aucun repli", async ({
  context,
  chronologie,
}) => {
  exigerLesPrealables(raison, "hors-ligne.spec.mjs");
  // PRÉALABLE du scénario, pas du produit : le serveur d'épreuve doit donner au CODE de la coquille une
  // fraîcheur (`playwright.e2e.config.mjs` lit `VAULT_E2E_CODE_MAX_AGE` et passe `--harnais-e2e-hors-ligne` à `tools/serve.mjs`). Sous les en-têtes de production (`no-cache`),
  // un Worker NEUF créé réseau coupé ne peut pas importer ses modules : le démarrage échoue
  // (`VAULT_COQUILLE_GESTE_ROMPU`) AVANT de lire la réserve — mesuré le 18/11/2026, moitié « code de la
  // coquille » de #299. Sans ce préalable, l'épreuve échouerait pour une raison qui n'est pas la sienne.
  expect(
    Number.parseInt(process.env.VAULT_E2E_CODE_MAX_AGE ?? "", 10) > 0,
    "préalable : VAULT_E2E_CODE_MAX_AGE=<secondes> (voir tools/serve.mjs, #299)",
  ).toBe(true);
  test.setTimeout(4_800_000);
  const erreurs = [];
  const noter = (etape, detail = {}) => chronologie.etape(etape, detail);
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));

  // --- 1. EN LIGNE : premier démarrage, la réserve et le descripteur scellé se remplissent ---------
  const page = await ouvrirLaCoquille(context, erreurs);
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  const premier = (await releve(page)).application;
  expect(premier.horsConnexion ?? null, "en ligne, aucune mention hors connexion").toBeNull();
  await expect(page.locator("#parcours-reussite")).not.toContainText(/hors connexion/i);
  const range = await lireLeRange(page);
  expect(range, "le descripteur scellé est rangé après l'acquisition complète").not.toBeNull();
  expect(String.fromCharCode(...range.slice(0, 8)), "magie du format v1").toBe("VLTDSC01");
  noter("premier-demarrage-en-ligne");

  // --- 2. RÉSEAU COUPÉ : la page est chargée, le coffre déverrouillé, « Démarrer » -----------------
  await verrouiller(page);
  await ouvrirParLaPhrase(page);
  const reponses = [];
  const echecs = [];
  page.on("response", (reponse) => reponses.push(new URL(reponse.url()).pathname));
  page.on("requestfailed", (requete) => echecs.push(new URL(requete.url()).pathname));
  await context.setOffline(true);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  await context.setOffline(false);
  const horsLigne = (await releve(page)).application;
  expect(horsLigne.demarree, "l'application répond, hors connexion").toBe(true);
  expect(horsLigne.horsConnexion, "la version et la date sont dites").toMatchObject({
    version: descripteur.application.version,
  });
  expect(Number.isInteger(horsLigne.horsConnexion.rangeLe)).toBe(true);
  // La personne LIT la date : « Hors connexion, version du <date>. » (revue de #298, constat 5).
  await expect(page.locator("#parcours-reussite")).toContainText(
    /Hors connexion, version du .+\d{4}/,
  );
  expect(echecs, "le descripteur n'a pas été atteint").toContain("/artifacts/application.json");
  const doImage = (chemin) =>
    chemin.startsWith("/artifacts/reference-image/") ||
    /^\/vendor\/v86\/artefacts\/.*\.(wasm|bin)$/.test(chemin);
  expect(reponses.filter(doImage), "aucun octet de l'image n'est servi par le réseau").toEqual([]);
  noter("demarrage-hors-ligne", { rangeLe: horsLigne.horsConnexion.rangeLe });

  // --- 3. CONTRE-ÉPREUVE : descripteur rangé ALTÉRÉ, réseau coupé : refus typé, pas de boot --------
  await verrouiller(page);
  await ouvrirParLaPhrase(page);
  await alterer(page);
  const altere = await lireLeRange(page);
  await context.setOffline(true);
  await exigerLeRefusAuDemarrage(page, "VAULT_COQUILLE_HORS_LIGNE_DESCRIPTEUR_REFUSE");
  await context.setOffline(false);
  noter("descripteur-altere-refuse");

  // --- 4. Le démarrage EN LIGNE suivant remplace le descripteur refusé par un descripteur sain -----
  await verrouiller(page);
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  const refait = await lireLeRange(page);
  expect(String.fromCharCode(...refait.slice(0, 8))).toBe("VLTDSC01");
  expect(refait, "le descripteur altéré a été remplacé").not.toEqual(altere);
  noter("descripteur-refait-en-ligne");

  // --- 5. L'origine RÉPOND mal : 500, puis HTML de portail captif — jamais de repli ----------------
  const motif = `${E2E_ORIGIN_COQUILLE}/artifacts/application.json`;
  for (const [nom, reponse] of [
    ["http-500", { status: 500, body: "" }],
    [
      "portail-captif",
      {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<html>Connectez-vous au Wi-Fi</html>",
      },
    ],
  ]) {
    await verrouiller(page);
    await ouvrirParLaPhrase(page);
    await context.route(motif, (route) => route.fulfill(reponse));
    await exigerLeRefusAuDemarrage(page, "VAULT_COQUILLE_APPLICATION_NON_SERVIE");
    await context.unroute(motif);
    noter(`origine-${nom}-sans-repli`);
  }
  expect(erreurs, "aucune erreur de page").toEqual([]);
  await page.close();
});
