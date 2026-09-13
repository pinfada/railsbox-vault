// Une écriture que Rails a ACQUITTÉE survit au VERROUILLAGE immédiat et au BOOT À FROID (#209).
//
// ## Le constat qu'il ferme
//
// Mesuré par la revue de la PR #208 (13/09/2026, coquille réelle, Chromium) : une note acquittée,
// puis « Verrouiller » après d secondes, puis l'instantané écarté et un boot à froid — perdue 4 fois
// sur 4 à d = 0 s, 1 fois sur 3 à 5 s, 0 fois sur 3 à 30 s. La cause (défi C-K du 13/09) : en
// `journal_mode = delete`, le commit est l'effacement du `-journal`, et `synchronous = full` ne
// synchronise pas le répertoire après lui ; `synchronous = extra` (ADR 0004, note du 13/09) le fait.
// La pièce jointe, téléversée APRÈS le commit par ActiveStorage, l'est désormais par un service qui
// synchronise fichier et répertoires.
//
// ## Ce qu'il prouve, dans l'ordre où il le prouve
//
//  1. la coquille s'ouvre par une phrase, installe le disque et démarre Rails ;
//  2. un utilisateur SOUMET une note ET une pièce jointe ; la page de la note s'affiche — c'est
//     l'acquittement, et la page affiche l'empreinte de la pièce relue ;
//  3. après d ∈ { 0, 0, 0, 5, 5, 5, 30, 30, 30 } secondes, « Verrouiller » ; la coquille se recharge ;
//  4. l'instantané laissé par le verrouillage est RETIRÉ de l'OPFS : la réouverture ne peut pas le
//     reprendre, et elle le PUBLIE (`instantaneUtilise: false`) ;
//  5. la même phrase rouvre, Rails boote À FROID sur le disque sans réinstaller, et la page de la note
//     précédente relit son libellé ET l'empreinte de sa pièce ;
//  5 bis. à CHAQUE boot, l'état du disque relevé par l'init (options, compteur d'erreurs du
//     superbloc, alertes du noyau, rejeu du journal) est lu sur la page d'accueil, et exigé sain ;
//  6. sur ce disque rouvert à froid, une NOUVELLE note et sa pièce sont écrites et acquittées — c'est
//     ce que l'ext2 sans journal refusait (inode doublement alloué, EIO) — puis verrouillées à leur
//     tour et relues après un SECOND boot à froid. Chacun des neuf délais est donc suivi d'une
//     écriture sur le disque qu'il a laissé (sauf le dernier), et chaque écriture d'une relecture.
//
// Les neuf tours sont TOUS joués avant de juger : une perte au deuxième tour ne doit pas cacher ce
// que les sept suivants auraient dit. Le relevé `reports/e2e/durabilite-du-commit.json` et la
// chronologie datée portent chaque tour.
//
// ## Ce qu'il ne prouve PAS
//
//  - la durabilité d'une écriture qui ne passe ni par SQLite ni par ActiveStorage (applications
//    tierces, P3) : rien ne la synchronise, et c'est une limite nommée, pas un oubli ;
//  - la coupure ENTRE le commit et le téléversement de la pièce (le 303 n'est pas parti) ;
//  - un autre moteur que Chromium, comme tous les scénarios de ce dossier.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";
import { INSTANTANE_SIDECAR_SUFFIX } from "../../src/vm/opfs-sync-access.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** La PHRASE du scénario. Publique, sans valeur : elle ouvre un coffre que l'épreuve fabrique. */
const PHRASE = "une phrase de durabilite du commit assez longue pour la calibration";

/** Les délais entre l'acquittement et le verrouillage, en secondes : trois essais chacun. */
const DELAIS_S = Object.freeze([0, 0, 0, 5, 5, 5, 30, 30, 30]);

/** La pièce jointe : 64 Kio déterministes, plusieurs blocs, loin du plafond d'un corps relayé. */
const OCTETS_DE_PIECE = 64 * 1024;

const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_DEVERROUILLAGE_MS = 180_000;
const BUDGET_PREMIERE_PAGE_MS = 300_000;
const BUDGET_VERROUILLAGE_MS = 600_000;

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

/** Une évaluation qui rend `null` au lieu de jeter quand la page navigue (le verrouillage recharge). */
async function sansNavigation(page, fonction, argument) {
  try {
    return await page.evaluate(fonction, argument);
  } catch {
    return null;
  }
}

/** La pièce du tour `rang` : distincte d'un tour à l'autre, pour qu'une pièce ne passe pas pour une autre. */
function pieceDuTour(rang) {
  const octets = Buffer.alloc(OCTETS_DE_PIECE);
  for (let index = 0; index < octets.length; index += 1)
    octets[index] = (index * 31 + rang * 7) % 251;
  return { octets, sha256: createHash("sha256").update(octets).digest("hex") };
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
  const application = (await releve(page)).application;
  await expect(pageServie(page).locator("body")).toHaveAttribute(
    "data-application-de-reference",
    "rendue",
    { timeout: BUDGET_PREMIERE_PAGE_MS },
  );
  return application;
}

/**
 * L'ÉTAT du disque applicatif que l'init du guest a relevé à CE boot et que la page d'accueil publie
 * (revue de la PR #211, constat 5) : sans lui, « l'écriture suivante réussit » ne distinguait pas un
 * disque sain d'un ext4 en erreur qui continuait d'écrire.
 */
async function lireEtatDuDisque(page) {
  const etat = pageServie(page).locator("#etat-du-disque");
  await etat.waitFor({ timeout: 60_000 });
  const attribut = (nom) => etat.getAttribute(`data-disque-${nom}`);
  return {
    releve: await attribut("releve"),
    options: await attribut("options"),
    erreurs: await attribut("erreurs"),
    alertes: await attribut("alertes"),
    rejeu: await attribut("rejeu"),
  };
}

/** RELIT la note d'un tour précédent : son libellé, et l'empreinte de sa pièce relue par Rails. */
async function relireLaNote(page, note) {
  const servie = pageServie(page);
  const lien = servie.locator(`[data-note="${note.identifiant}"]`);
  const listee = await lien.waitFor({ timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  if (!listee) return { listee: false, libelle: null, pieceSha256: null, pieceEtat: null };
  await lien.click();
  await expect(servie.locator("#identifiant-note")).toHaveText(note.identifiant, {
    timeout: 120_000,
  });
  const libelle = (await servie.locator("#libelle-note").textContent()).trim();
  const piece = servie.locator("#piece-note");
  const pieceSha256 =
    (await piece.count()) === 0 ? null : await piece.getAttribute("data-piece-sha256");
  const pieceEtat =
    (await piece.count()) === 0 ? "absente" : await piece.getAttribute("data-piece-etat");
  await servie.locator("#retour").click();
  await expect(servie.locator("#formulaire-note")).toBeVisible({ timeout: 120_000 });
  return { listee, libelle, pieceSha256, pieceEtat };
}

/** ÉCRIT une note et sa pièce ; rend ce que la page d'acquittement a affiché. */
async function ecrireUneNote(page, rang) {
  const servie = pageServie(page);
  const libelle = `note durable du tour ${rang} (#209)`;
  const piece = pieceDuTour(rang);
  await servie.locator("#libelle").fill(libelle);
  await servie.locator("#piece").setInputFiles({
    name: `piece-${rang}.bin`,
    mimeType: "application/octet-stream",
    buffer: piece.octets,
  });
  await servie.locator("#enregistrer").click();
  await expect(servie.locator("#libelle-note")).toHaveText(libelle, { timeout: 120_000 });
  // L'ACQUITTEMENT : la page de la note est rendue, et elle affiche la pièce relue à l'octet.
  await expect(servie.locator("#piece-note")).toHaveAttribute("data-piece-sha256", piece.sha256, {
    timeout: 30_000,
  });
  const identifiant = (await servie.locator("#identifiant-note").textContent()).trim();
  expect(identifiant).toMatch(/^[0-9a-f-]{36}$/);
  return { rang, identifiant, libelle, pieceSha256: piece.sha256 };
}

/** VERROUILLE et attend la coquille rechargée, verrouillée et prête. */
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

/** RETIRE chaque instantané de l'OPFS : la réouverture suivante boote à froid, par construction. */
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

test("une note et sa pièce acquittées survivent au verrouillage à 0, 5 et 30 s puis au boot à froid", async ({
  context,
  chronologie,
}, testInfo) => {
  exigerLesPrealables(raison, "durabilite-du-commit.spec.mjs");
  test.setTimeout(5_400_000);
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
      join(DOSSIER_RAPPORTS, "durabilite-du-commit.json"),
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
    tour.disque = await lireEtatDuDisque(page);
    chronologie.etape("etat-du-disque-lu", { rang, ...tour.disque });

    if (precedente !== null) {
      tour.relecture = { note: precedente, ...(await relireLaNote(page, precedente)) };
      chronologie.etape("note-precedente-relue", {
        rang,
        delaiS: precedente.delaiS,
        listee: tour.relecture.listee,
        pieceRelue: tour.relecture.pieceSha256 === precedente.pieceSha256,
      });
    }

    if (rang === DELAIS_S.length) {
      tours.push(tour);
      ecrireLeReleve();
      break;
    }

    const delaiS = DELAIS_S[rang];
    const note = await ecrireUneNote(page, rang);
    const acquitteeA = Date.now();
    chronologie.etape("note-et-piece-acquittees", { rang, identifiant: note.identifiant, delaiS });
    if (delaiS > 0) await page.waitForTimeout(delaiS * 1_000);
    tour.delaiReelAvantVerrouillageMs = Date.now() - acquitteeA;
    const departVerrou = Date.now();
    await verrouiller(page);
    tour.verrouillageMs = Date.now() - departVerrou;
    tour.instantanesRetires = await retirerLesInstantanes(page);
    chronologie.etape("verrouille-instantane-retire", {
      rang,
      delaiReelMs: tour.delaiReelAvantVerrouillageMs,
      retires: tour.instantanesRetires.length,
    });
    precedente = { ...note, delaiS };
    tour.ecrite = precedente;
    tours.push(tour);
    ecrireLeReleve();
  }

  const rapport = ecrireLeReleve();
  await testInfo.attach("durabilite-du-commit.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  // --- Le JUGEMENT, une fois les neuf tours joués ----------------------------------------------
  const relectures = tours.filter((tour) => tour.relecture !== undefined);
  expect(relectures).toHaveLength(DELAIS_S.length);
  const tableau = relectures.map(({ rang, boot, relecture, ecrite }) => ({
    delaiS: relecture.note.delaiS,
    bootMs: boot.bootMs,
    bootAFroid: boot.instantaneUtilise === false && boot.installee === false,
    // Le dernier tour ne réécrit pas : il n'y aurait plus de boot à froid pour relire.
    ecritureApresRelecture: rang === DELAIS_S.length ? null : ecrite !== undefined,
    noteRelue: relecture.listee && relecture.libelle === relecture.note.libelle,
    pieceRelue: relecture.pieceSha256 === relecture.note.pieceSha256,
    rang,
  }));
  process.stdout.write(`\n[durabilite-du-commit] ${JSON.stringify(tableau)}\n`);
  for (const tour of tours.slice(0, DELAIS_S.length)) {
    expect(
      tour.instantanesRetires.length,
      `tour ${tour.rang} : un instantané a été retiré`,
    ).toBeGreaterThan(0);
  }
  expect(
    tableau.filter(
      (ligne) =>
        !(
          ligne.bootAFroid &&
          ligne.noteRelue &&
          ligne.pieceRelue &&
          ligne.ecritureApresRelecture !== false
        ),
    ),
    "chaque note acquittée — et sa pièce — est relue après un verrouillage et un boot À FROID, et le disque rouvert accepte l'écriture suivante",
  ).toEqual([]);
  expect(
    tours
      .map(({ rang, disque }) => ({ rang, ...disque }))
      .filter(
        (etat) =>
          !(
            etat.releve === "oui" &&
            etat.erreurs === "0" &&
            etat.alertes === "0" &&
            /(^|,)errors=remount-ro(,|$)/.test(etat.options ?? "")
          ),
      ),
    "à chaque boot, le disque applicatif est monté errors=remount-ro, sans erreur au superbloc ni ligne « EXT4-fs error » ou « mounting unchecked » du noyau",
  ).toEqual([]);
  expect(erreurs, "aucune erreur de page").toEqual([]);
});
