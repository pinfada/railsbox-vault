// LA PREUVE qui manquait (#45, étape 3) : la coquille démarre l'application sur l'ARBRE PUBLIÉ SEUL.
//
// `tests/e2e/hors-ligne.spec.mjs` publie l'arbre puis sert `/artifacts/` depuis le dossier LOCAL
// `artifacts/` (option `artefacts` de `tools/publier-servir.mjs`) : l'image n'y est jamais publiée, et
// aucune épreuve ne prouvait donc que ce que l'hébergeur recevrait suffit à démarrer. Ici l'arbre est
// construit avec `--avec-image` et servi SANS cette option : un fichier que l'arbre ne porte pas est un
// 404, comme chez l'hébergeur.
//
// Ce que ce fichier prouve : (1) chaque artefact que le descripteur nomme est servi par l'arbre, à la
// taille annoncée ; (2) un arbre construit SANS `--avec-image` ne porte pas le descripteur (contre-épreuve :
// la preuve dépend bien de l'arbre) ; (3) premier démarrage EN LIGNE : déverrouillage, boot Rails, page
// rendue, sous les en-têtes de production. Ce qu'il ne prouve pas : un hébergeur réel, Firefox, WebKit,
// le hors connexion (`hors-ligne.spec.mjs`).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import {
  E2E_HOST,
  E2E_HOST_B,
  E2E_ORIGIN_PUBLIEE,
  E2E_ORIGIN_PUBLIEE_APP,
  E2E_PUBLIE_APP_PORT,
  E2E_PUBLIE_PORT,
} from "../../playwright.e2e.config.mjs";
import { fichiersDeLImage } from "../../tools/publier-image.mjs";
import { demarrer } from "../../tools/publier-servir.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const AVEC_IMAGE = join(RACINE, "artifacts", "publication-e2e-image");
const SANS_IMAGE = join(RACINE, "artifacts", "publication-e2e-sans-image");

const PHRASE = "une phrase de publication seule assez longue pour la calibration argon";
const BUDGET_DEMARRAGE_MS = 600_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:build »`;
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}
const raison = raisonDIndisponibilite();

function publier(sortie, ...options) {
  execFileSync(
    process.execPath,
    [
      "tools/publier.mjs",
      "--sortie",
      sortie,
      "--origine-coquille",
      E2E_ORIGIN_PUBLIEE,
      "--origine-application",
      E2E_ORIGIN_PUBLIEE_APP,
      "--sequence",
      "1",
      ...options,
    ],
    { cwd: RACINE, stdio: "pipe" },
  );
}

/** Les deux origines sur l'arbre SEUL : jamais d'option `artefacts`, donc jamais le dossier local. */
async function servir(sortie) {
  const coquille = await demarrer({
    arbre: join(sortie, "coquille"),
    host: E2E_HOST,
    port: E2E_PUBLIE_PORT,
    retires: [],
  });
  const application = await demarrer({
    arbre: join(sortie, "application"),
    host: E2E_HOST_B,
    port: E2E_PUBLIE_APP_PORT,
    retires: [],
  });
  return {
    coquille,
    arreter: () => Promise.all([coquille.arreter(), application.arreter()]),
  };
}

test("l'arbre publié AVEC l'image sert chaque artefact que le descripteur nomme, à la taille annoncée", async () => {
  exigerLesPrealables(raison, "publie-seul.spec.mjs");
  publier(AVEC_IMAGE, "--avec-image");
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  const origines = await servir(AVEC_IMAGE);
  try {
    const reponse = await fetch(`${E2E_ORIGIN_PUBLIEE}/artifacts/application.json`);
    expect(reponse.status).toBe(200);
    for (const { nom, octets } of fichiersDeLImage(descripteur)) {
      const url = `${E2E_ORIGIN_PUBLIEE}${descripteur.prefixeDesArtefacts}${nom}`;
      // GET et non HEAD : le serveur de l'arbre ne rend pas de `content-length` à un HEAD. On COMPTE les
      // octets servis, sans les garder.
      const servi = await fetch(url);
      expect(servi.status, url).toBe(200);
      let recus = 0;
      for await (const morceau of servi.body) recus += morceau.byteLength;
      expect(recus, url).toBe(octets);
      expect(
        statSync(join(AVEC_IMAGE, "coquille", descripteur.prefixeDesArtefacts, nom)).size,
      ).toBe(octets);
    }
  } finally {
    await origines.arreter();
  }
});

test("CONTRE-ÉPREUVE : sans --avec-image, l'arbre publié ne sert ni le descripteur ni l'image", async () => {
  exigerLesPrealables(raison, "publie-seul.spec.mjs");
  publier(SANS_IMAGE);
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  const origines = await servir(SANS_IMAGE);
  try {
    const url = `${E2E_ORIGIN_PUBLIEE}${descripteur.prefixeDesArtefacts}${descripteur.rootfs.nom}`;
    expect((await fetch(url, { method: "HEAD" })).status, "le rootfs n'est pas servi").toBe(404);
  } finally {
    await origines.arreter();
  }
});

test("premier démarrage EN LIGNE sur l'arbre publié seul : déverrouillage, boot Rails, page rendue", async ({
  context,
}) => {
  exigerLesPrealables(raison, "publie-seul.spec.mjs");
  test.setTimeout(1_200_000);
  publier(AVEC_IMAGE, "--avec-image");
  const origines = await servir(AVEC_IMAGE);
  const erreurs = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (erreur) => erreurs.push(erreur.message));
    await page.goto(`${E2E_ORIGIN_PUBLIEE}/index.html?vue=complete`, { waitUntil: "load" });
    await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
      timeout: 60_000,
    });
    await page.fill("#saisie-phrase", PHRASE);
    await page.click("#ouvrir-par-phrase");
    await expect
      .poll(async () => JSON.parse(await page.locator("#coquille-rapport").textContent()).etat, {
        timeout: 120_000,
      })
      .toBe("ouvert");
    await page.click("#demarrer-application");
    await expect(page.locator("#cycle-etat")).toHaveText(
      /^cycle:(application-demarree|demarrage-refuse)/,
      { timeout: BUDGET_DEMARRAGE_MS },
    );
    expect(await page.locator("#cycle-etat").textContent()).toBe("cycle:application-demarree");

    // Tout ce que le boot a demandé sous `/artifacts/` est dans l'ARBRE : rien n'est venu d'ailleurs.
    const demandes = origines.coquille.journal
      .map(({ chemin }) => chemin)
      .filter((chemin) => chemin.startsWith("/artifacts/"));
    expect(demandes.length, "le boot a demandé l'image").toBeGreaterThanOrEqual(6);
    for (const chemin of new Set(demandes)) {
      expect(existsSync(join(AVEC_IMAGE, "coquille", chemin.slice(1))), chemin).toBe(true);
    }
    expect(erreurs, "aucune erreur de page").toEqual([]);
  } finally {
    await origines.arreter();
  }
});
