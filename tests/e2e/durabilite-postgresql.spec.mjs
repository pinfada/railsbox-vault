// E2 (#343) : un COMMIT acquitté par une application PostgreSQL survit au VERROUILLAGE immédiat et
// au BOOT À FROID, dans la coquille réelle — la chaîne entière, du `fsync` du guest à la génération
// OPFS validée.
//
// ## L'application
//
// `apps/rails-new-postgresql`, générée par `rails _8.1.4.1_ new -d postgresql` puis
// `bin/rails generate scaffold Note libelle:string`, SANS aucune modification pour le coffre
// (ADR 0056, exigence de #272). L'outil lit `adapter: postgresql` dans son `config/database.yml`,
// prépare le cluster sur la graine, démarre PostgreSQL après le montage du disque de données et
// fournit `DATABASE_URL` à Rails. L'épreuve ne connaît de l'application que ce que le générateur a
// produit : le formulaire `notes/new`, la page de la note, la liste `notes`.
//
// ## Ce qu'elle prouve, sur le modèle de `durabilite-du-commit.spec.mjs` (#209)
//
//  1. la coquille s'ouvre par une phrase et démarre l'application ;
//  2. une note est SOUMISE par le formulaire ; la page de la note s'affiche avec son libellé — c'est
//     l'acquittement : Rails ne redirige qu'après le COMMIT ;
//  3. après d ∈ { 0, 0, 0, 5, 5, 5 } secondes, « Verrouiller » ; la coquille se recharge ;
//  4. l'instantané laissé par le verrouillage est RETIRÉ de l'OPFS : la réouverture boote à froid et
//     le publie (`instantaneUtilise: false`) — PostgreSQL y fait donc sa reprise sur crash ;
//  5. la même phrase rouvre, l'application redémarre, et la liste des notes relit le libellé ;
//  6. sur ce disque rouvert, une NOUVELLE note est écrite et acquittée, puis verrouillée à son tour.
//
// Les tours sont TOUS joués avant de juger. Le relevé `reports/e2e/durabilite-postgresql.json` les
// porte.
//
// ## Ce qu'elle ne prouve PAS
//
//  - l'état du disque relevé par l'init : la référence l'affiche sur sa page d'accueil, une
//    application non modifiée n'a aucune page pour cela ;
//  - la coupure pendant un CHECKPOINT et la cohérence des pages (E3, `amcheck`, `pg_checksums`) ;
//  - l'instantané suivi d'une écriture (E4) ;
//  - le témoin `synchronous_commit = off` dans la coquille : voir l'ADR 0056, § « Témoin négatif ».
//
// ## Dépendance
//
// La coquille déclare l'application démarrée quand sa sonde répond. Jusqu'à #351, cette sonde est
// `/vault/health`, une route que seule la référence possède : sans #351, cette épreuve échoue au
// démarrage, pour une raison qui n'est pas PostgreSQL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";
import { INSTANTANE_SIDECAR_SUFFIX } from "../../src/vm/opfs-sync-access.mjs";
import { GESTE_DU_TEMOIN, ID_DU_TEMOIN } from "../../tools/vm/postgresql-temoin.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** La PHRASE du scénario. Publique, sans valeur : elle ouvre un coffre que l'épreuve fabrique. */
const PHRASE = "une phrase de durabilite postgresql assez longue pour la calibration";

/** Les délais entre l'acquittement et le verrouillage, en secondes : trois essais chacun. */
const DELAIS_S = Object.freeze([0, 0, 0, 5, 5, 5]);

const BUDGET_DEMARRAGE_MS = 900_000;
const BUDGET_DEVERROUILLAGE_MS = 180_000;
const BUDGET_PAGE_MS = 180_000;
const BUDGET_VERROUILLAGE_MS = 600_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) return "manifeste de l'image absent : « npm run image:build »";
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  if (manifeste.application?.id !== ID_DU_TEMOIN) {
    return `le paquet servi est ${manifeste.application?.id ?? "inconnu"}, pas le témoin PostgreSQL : ${GESTE_DU_TEMOIN}`;
  }
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) return `artefacts absents (${absents.join(", ")})`;
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

async function sansNavigation(page, fonction, argument) {
  try {
    return await page.evaluate(fonction, argument);
  } catch {
    return null;
  }
}

/** NAVIGUE le cadre servi vers un chemin de l'application, comme un lien suivi. */
async function naviguer(page, chemin) {
  await pageServie(page)
    .locator("html")
    .evaluate((_, cible) => location.assign(cible), chemin);
}

async function ouvrirEtDemarrer(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: BUDGET_DEVERROUILLAGE_MS })
    .toBe("ouvert");
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText(
    /^cycle:(application-demarree|demarrage-refuse)/,
    { timeout: BUDGET_DEMARRAGE_MS },
  );
  await expect(page.locator("#cycle-etat")).toHaveText("cycle:application-demarree");
  return (await releve(page)).application;
}

/** ÉCRIT une note par le formulaire du scaffold ; rend son libellé une fois la page de la note rendue. */
async function ecrireUneNote(page, rang) {
  const libelle = `note durable PostgreSQL du tour ${rang} (#343)`;
  await naviguer(page, "/notes/new");
  const servie = pageServie(page);
  await servie.locator("#note_libelle").fill(libelle, { timeout: BUDGET_PAGE_MS });
  await servie.locator('input[type="submit"]').click();
  // L'ACQUITTEMENT : Rails ne redirige vers la page de la note qu'après le COMMIT.
  await expect(servie.locator("body")).toContainText(libelle, { timeout: BUDGET_PAGE_MS });
  await expect(servie.locator("body")).toContainText("successfully created");
  return { rang, libelle };
}

/** RELIT la liste des notes, et dit si le libellé y est. */
async function noteListee(page, libelle) {
  await naviguer(page, "/notes");
  const servie = pageServie(page);
  await expect(servie.locator("h1")).toHaveText("Notes", { timeout: BUDGET_PAGE_MS });
  return (await servie.locator("body").textContent()).includes(libelle);
}

async function verrouiller(page) {
  const origine = await sansNavigation(page, () => performance.timeOrigin);
  await page.click("#verrouiller-le-coffre");
  await expect
    .poll(
      () =>
        sansNavigation(
          page,
          (avant) =>
            performance.timeOrigin !== avant &&
            document.documentElement.dataset.coquille === "prete",
          origine,
        ),
      { timeout: BUDGET_VERROUILLAGE_MS, intervals: [500] },
    )
    .toBe(true);
  expect((await releve(page)).etat, "la coquille rechargée est verrouillée").toBe("verrouille");
}

async function retirerLesInstantanes(page) {
  return page.evaluate(async (suffixe) => {
    const volumes = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("vault-volumes");
    const retires = [];
    for await (const [nom, poignee] of volumes.entries()) {
      if (poignee.kind !== "file" || !nom.endsWith(suffixe)) continue;
      const octets = (await poignee.getFile()).size;
      await volumes.removeEntry(nom);
      retires.push({ nom, octets });
    }
    return retires;
  }, INSTANTANE_SIDECAR_SUFFIX);
}

test("une note acquittée par PostgreSQL survit au verrouillage à 0 et 5 s puis au boot à froid", async ({
  context,
  chronologie,
}, testInfo) => {
  exigerLesPrealables(raison, "durabilite-postgresql.spec.mjs");
  test.setTimeout(7_200_000);
  const depart = Date.now();
  const erreurs = [];
  const page = await context.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60_000 });

  const tours = [];
  let precedente = null;
  const ecrireLeReleve = () => {
    mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
    const rapport = { mesureLe: new Date().toISOString(), delaisS: DELAIS_S, tours, erreurs };
    writeFileSync(
      join(DOSSIER_RAPPORTS, "durabilite-postgresql.json"),
      `${JSON.stringify(rapport, null, 2)}\n`,
      "utf8",
    );
    return rapport;
  };

  for (let rang = 0; rang <= DELAIS_S.length; rang += 1) {
    const tour = { rang, debutMs: Date.now() - depart };
    const application = await ouvrirEtDemarrer(page);
    tour.boot = {
      bootMs: application.bootMs,
      installee: application.installation?.installee ?? null,
      instantaneUtilise: application.instantaneUtilise ?? null,
    };
    chronologie.etape("application-demarree", { rang, ...tour.boot });

    if (precedente !== null) {
      tour.relecture = { note: precedente, listee: await noteListee(page, precedente.libelle) };
      chronologie.etape("note-precedente-relue", { rang, ...tour.relecture });
    }
    if (rang === DELAIS_S.length) {
      tours.push(tour);
      break;
    }

    const delaiS = DELAIS_S[rang];
    const note = await ecrireUneNote(page, rang);
    const acquitteeA = Date.now();
    chronologie.etape("note-acquittee", { rang, delaiS });
    if (delaiS > 0) await page.waitForTimeout(delaiS * 1_000);
    tour.delaiReelAvantVerrouillageMs = Date.now() - acquitteeA;
    const departVerrou = Date.now();
    await verrouiller(page);
    tour.verrouillageMs = Date.now() - departVerrou;
    tour.instantanesRetires = await retirerLesInstantanes(page);
    chronologie.etape("verrouille-instantane-retire", {
      rang,
      retires: tour.instantanesRetires.length,
    });
    precedente = { ...note, delaiS };
    tour.ecrite = precedente;
    tours.push(tour);
    ecrireLeReleve();
  }

  const rapport = ecrireLeReleve();
  await testInfo.attach("durabilite-postgresql.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  const tableau = tours
    .filter((tour) => tour.relecture !== undefined)
    .map(({ rang, boot, relecture }) => ({
      rang,
      delaiS: relecture.note.delaiS,
      bootMs: boot.bootMs,
      bootAFroid: boot.instantaneUtilise === false && boot.installee === false,
      noteRelue: relecture.listee,
    }));
  process.stdout.write(`\n[durabilite-postgresql] ${JSON.stringify(tableau)}\n`);
  expect(tableau).toHaveLength(DELAIS_S.length);
  for (const tour of tours.slice(0, DELAIS_S.length)) {
    expect(tour.instantanesRetires.length, `tour ${tour.rang} : instantané retiré`).toBeGreaterThan(
      0,
    );
  }
  expect(
    tableau.filter((ligne) => !(ligne.bootAFroid && ligne.noteRelue)),
    "chaque note acquittée par PostgreSQL est relue après un verrouillage et un boot À FROID, et le disque rouvert accepte l'écriture suivante",
  ).toEqual([]);
  expect(erreurs, "aucune erreur de page").toEqual([]);
});
