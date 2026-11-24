// La RÉSERVE au DÉMARRAGE (#299, ADR 0048 §§ 2 à 4 et 7) sur l'arbre PUBLIÉ, sous les en-têtes de
// production, trois moteurs : première visite, garde fermée, origine hostile, fermeture et réouverture du
// navigateur sans origine. Critères 1, 2, 6 et 13 (a, b : sans le boot Rails — il est dans `tests/e2e/`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  MAUVAIS,
  Origine,
  portDe,
  attendreLaCoquille,
  fabriquerGeneration,
  jusqua,
  lireLeReleve,
  ouvrirUnNavigateur,
  visiter,
} from "./support-reserve.mjs";

let origine;
let navigateur;
test.beforeEach(async ({ browserName }) => {
  origine = new Origine({ port: portDe(browserName) });
  origine.publier(fabriquerGeneration({ sequence: 1 }));
  await origine.demarrer();
});
test.afterEach(async () => {
  await navigateur?.fermer();
  navigateur = null;
  await origine.arreter();
});

test("PREMIÈRE VISITE : « préparation hors connexion », une installation, un rechargement, puis la coquille démarre sous le portail", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  const releve = await visiter(page, origine);
  expect(releve.rapport.reserve.refus).toBeNull();
  expect(releve.rapport.reserve.sequence).toBe(1);
  expect(releve.rapport.reserve.fraicheur).toBe("version-verifiee");
  expect(releve.bandeau).toBe("version-verifiee");
  expect(releve.workers).toBeGreaterThanOrEqual(1);
  // La page est contrôlée par le SW de la coquille, à la racine.
  const controle = await page.evaluate(() => ({
    controleur: navigator.serviceWorker.controller?.scriptURL,
    portee: null,
  }));
  expect(controle.controleur).toBe(`${origine.origine}/sw-coquille.mjs`);
  expect(page.erreurs).toEqual([]);
});

test("GARDE FERMÉE : sous contrôle, tout ce qui n'est pas listé est refusé par le SW et n'atteint JAMAIS l'origine (critère 6)", async ({
  browserName,
}) => {
  // Un fichier que l'origine SERT mais que la liste n'épingle pas : le SW ne doit pas le laisser passer.
  origine.regler("/pas-epingle.mjs", { corps: "export const PIRE = 1;\n" });
  origine.regler("/MAIN.mjs", { corps: "export const PIRE = 2;\n" });
  origine.regler("//main.mjs", { corps: "export const PIRE = 3;\n" });
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  origine.vider();
  const resultats = await page.evaluate(async () => {
    const sortie = {};
    const refus = async (nom, essai) => {
      try {
        const reponse = await essai();
        sortie[nom] =
          reponse instanceof Response
            ? [reponse.status, reponse.headers.get("X-Vault-Refus")]
            : "ok";
      } catch (erreur) {
        sortie[nom] = "echec:" + erreur.name;
      }
    };
    await refus("fetch", () => fetch("/pas-epingle.mjs"));
    await refus("fetch-requete", () => fetch("/MAIN.mjs"));
    await refus("fetch-double-barre", () => fetch(location.origin + "//main.mjs"));
    await refus("fetch-post", () => fetch("/main.mjs", { method: "POST", body: "x" }));
    await refus("import", () => import("/pas-epingle.mjs"));
    await refus("worker", () => {
      const travailleur = new Worker("/pas-epingle.mjs", { type: "module" });
      return new Promise((resoudre, rejeter) => {
        travailleur.onerror = () => rejeter(new Error("worker-refuse"));
        travailleur.onmessage = () => resoudre("charge");
        setTimeout(() => rejeter(new Error("worker-sans-reponse")), 3000);
      });
    });
    await refus(
      "script",
      () =>
        new Promise((resoudre, rejeter) => {
          const balise = document.createElement("script");
          balise.src = "/pas-epingle.mjs";
          balise.onload = () => resoudre("charge");
          balise.onerror = () => rejeter(new Error("script-refuse"));
          document.head.append(balise);
        }),
    );
    await refus("hors-origine", () =>
      fetch("http://localhost:4194/document-applicatif.html", { mode: "no-cors" }),
    );
    await refus("artefacts-importes", () => import("/artifacts/application.json"));
    return sortie;
  });
  for (const nom of ["fetch", "fetch-requete", "fetch-double-barre"]) {
    expect(resultats[nom][0], nom).toBe(503);
    expect(resultats[nom][1], nom).toBeTruthy();
  }
  for (const nom of ["fetch-post", "import", "worker", "script", "artefacts-importes"]) {
    expect(String(resultats[nom]), nom).toMatch(/echec|^503|refuse|,/);
  }
  expect(String(resultats.import)).toMatch(/^echec/);
  expect(String(resultats.worker)).not.toBe("ok");
  expect(
    origine.requetes(
      (r) =>
        r.chemin === "/pas-epingle.mjs" || r.chemin === "/MAIN.mjs" || r.chemin === "//main.mjs",
    ),
    "l'origine n'a reçu aucune de ces requêtes",
  ).toEqual([]);
  expect(origine.requetes((r) => r.chemin === "/main.mjs" && r.methode === "POST")).toEqual([]);
});

test("TOUT ce que la coquille charge hors `/artifacts/` est SERVI PAR LE SW (`fromServiceWorker`), pas par l'origine", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  const horsSW = [];
  page.on("response", (reponse) => {
    const chemin = new URL(reponse.url()).pathname;
    if (
      new URL(reponse.url()).origin === origine.origine &&
      !chemin.startsWith("/artifacts/") &&
      chemin !== "/sw-coquille.mjs" &&
      !reponse.fromServiceWorker()
    )
      horsSW.push(chemin);
  });
  origine.vider();
  await page.reload({ waitUntil: "load" });
  await attendreLaCoquille(page);
  expect(horsSW).toEqual([]);
  expect(
    origine.requetes((r) => !r.chemin.startsWith("/artifacts/") && r.chemin !== "/sw-coquille.mjs"),
    "le seul fichier que l'origine voit est le script du SW",
  ).toEqual([]);
});

test("ORIGINE HOSTILE : après l'installation, l'origine répond « MAUVAIS » à tout — un client contrôlé n'exécute JAMAIS ses octets (critère 2)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  origine.hostile = true;
  origine.vider();
  const page2 = await navigateur.page();
  const releve = await visiter(page2, origine);
  expect(releve.rapport.reserve.refus).toBeNull();
  expect(releve.coquille).not.toBe("reserve-refusee");
  const html = await page2.content();
  expect(html).not.toContain(MAUVAIS.trim());
  const exemples = await page2.evaluate(
    async () =>
      (await import("/src/coquille/refus-de-coquille.mjs")).CODES_REFUS_COQUILLE.reserveAbsente,
  );
  expect(exemples).toBe("VAULT_COQUILLE_RESERVE_ABSENTE");
  expect(
    origine.requetes((r) => r.chemin.endsWith(".mjs") && r.chemin !== "/sw-coquille.mjs"),
    "aucune requête de code à l'origine",
  ).toEqual([]);
});

test("FERMETURE ET RÉOUVERTURE du navigateur, ORIGINE ARRÊTÉE : la page, le code et le Worker sont servis par la réserve (critères 1 et 13b, sans boot)", async ({
  browserName,
}) => {
  const profil = mkdtempSync(join(tmpdir(), "reserve-profil-"));
  try {
    navigateur = await ouvrirUnNavigateur(browserName, { profil });
    const page = await navigateur.page();
    const premier = await visiter(page, origine);
    expect(premier.rapport.reserve.refus).toBeNull();
    await navigateur.fermer();
    await origine.arreter();
    navigateur = await ouvrirUnNavigateur(browserName, { profil });
    const page2 = navigateur.contexte.pages()[0] ?? (await navigateur.page());
    const releve = await visiter(page2, origine);
    expect(
      releve.rapport.reserve.refus,
      "l'origine est arrêtée : la coquille s'ouvre depuis la réserve",
    ).toBeNull();
    expect(releve.coquille).not.toBe("reserve-refusee");
    expect(releve.workers).toBeGreaterThanOrEqual(1);
    expect(releve.rapport.reserve.fraicheur).toBe("version-courante-non-verifiable");
    expect(
      await jusqua(
        async () => (await lireLeReleve(page2)).bandeau === "version-courante-non-verifiable",
      ),
    ).toBe(true);
  } finally {
    await navigateur?.fermer();
    navigateur = null;
    rmSync(profil, { recursive: true, force: true });
  }
});
