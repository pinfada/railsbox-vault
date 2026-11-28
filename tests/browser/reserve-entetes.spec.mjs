// Les EN-TÊTES rejoués par le SW et les DEUX ORIGINES (#299, ADR 0048 §§ 3 et 12), trois moteurs.
// Critères 9 (égalité chemin par chemin, CSP effective) et 11 (deux origines sans canal, requête
// inter-origine du propre client refusée).

import { expect, test } from "@playwright/test";

import {
  Origine,
  attendreLeTelechargementAnticipe,
  entetesDeProduction,
  fabriquerGeneration,
  ouvrirUnNavigateur,
  portDe,
  visiter,
} from "./support-reserve.mjs";

let origine;
let autre;
let navigateur;
test.beforeEach(async ({ browserName }) => {
  origine = new Origine({ port: portDe(browserName, 4) });
  autre = new Origine({ port: portDe(browserName, 4) + 1, hote: "localhost" });
  for (const o of [origine, autre]) o.publier(fabriquerGeneration({ sequence: 1 }));
  await origine.demarrer();
  await autre.demarrer();
});
test.afterEach(async () => {
  await navigateur?.fermer();
  navigateur = null;
  await origine.arreter();
  await autre.arreter();
});

const normaliser = (entetes) =>
  Object.fromEntries(Object.entries(entetes).map(([nom, valeur]) => [nom.toLowerCase(), valeur]));

test("ÉGALITÉ des en-têtes : ce que le SW sert est, chemin par chemin, ce que le serveur de production sert (critère 9)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  const chemins = [
    "/index.html",
    "/",
    "/main.mjs",
    "/runtime-worker.mjs",
    "/coquille/parcours.css",
    "/vendor/argon2/argon2.wasm",
    "/favicon.ico",
  ];
  for (const chemin of chemins) {
    const vus = await page.evaluate(async (c) => {
      const reponse = await fetch(c);
      return { statut: reponse.status, entetes: Object.fromEntries(reponse.headers) };
    }, chemin);
    expect(vus.statut, chemin).toBe(200);
    const attendus = normaliser(entetesDeProduction(chemin === "/" ? "/index.html" : chemin));
    expect(
      Object.keys(attendus).length,
      `${chemin} porte des en-têtes de production`,
    ).toBeGreaterThan(0);
    for (const [nom, valeur] of Object.entries(attendus)) {
      expect(vus.entetes[nom], `${chemin} · ${nom}`).toBe(valeur);
    }
  }
  const page_ = await page.evaluate(async () =>
    Object.fromEntries((await fetch("/index.html")).headers),
  );
  for (const nom of [
    "content-security-policy",
    "cross-origin-opener-policy",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
  ]) {
    expect(page_[nom], `la page porte ${nom}`).toBeTruthy();
  }
});

test("CSP EFFECTIVE sous le SW : un script inline est REFUSÉ et la violation est émise — sans une requête réseau (critère 9)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  // La VISITE réussie lance le téléchargement anticipé (#348), qui lit le descripteur public — exclu
  // de la réserve par l'ADR 0048 (ADR 0053, Conséquences). Ce qui est mesuré ici est ce que la
  // VIOLATION fait partir : la visite finit d'abord, puis le journal repart de zéro.
  await attendreLeTelechargementAnticipe(page);
  origine.vider();
  const issue = await page.evaluate(
    () =>
      new Promise((resoudre) => {
        document.addEventListener(
          "securitypolicyviolation",
          (e) => resoudre({ violation: e.violatedDirective }),
          { once: true },
        );
        window.__inline = false;
        const balise = document.createElement("script");
        balise.textContent = "window.__inline = true;";
        document.head.append(balise);
        setTimeout(() => resoudre({ violation: null, execute: window.__inline }), 1500);
      }),
  );
  expect(issue.violation).toMatch(/script-src/);
  expect(await page.evaluate(() => window.__inline)).toBe(false);
  expect(origine.requetes()).toEqual([]);
});

test("DEUX ORIGINES (sens coquille → application) : la requête inter-origine du propre client du SW est REFUSÉE et l'autre origine reçoit ZÉRO requête (critère 11)", async ({
  browserName,
}) => {
  // Une page de la réserve SANS CSP : la CSP (`connect-src 'self'`) est la première barrière, le SW la seconde.
  origine.publier(
    fabriquerGeneration({
      sequence: 1,
      surcharges: { "/sans-csp.html": "<!doctype html><title>sans csp</title><p>x</p>" },
      sansEntete: { "/sans-csp.html": ["Content-Security-Policy"] },
    }),
  );
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  await page.goto(`${origine.origine}/sans-csp.html`);
  expect(
    await page.evaluate(() => !!navigator.serviceWorker.controller),
    "la page est contrôlée",
  ).toBe(true);
  autre.vider();
  const issue = await page.evaluate(async (cible) => {
    const sortie = {};
    try {
      const reponse = await fetch(`${cible}/index.html`, { mode: "no-cors" });
      sortie.fetch = [reponse.type, reponse.status];
    } catch (erreur) {
      sortie.fetch = "echec:" + erreur.name;
    }
    try {
      const travailleur = new Worker(`${cible}/main.mjs`, { type: "module" });
      sortie.worker = await new Promise((resoudre) => {
        travailleur.onerror = () => resoudre("refuse");
        setTimeout(() => resoudre("sans-reponse"), 2000);
      });
    } catch (erreur) {
      sortie.worker = "echec:" + erreur.name;
    }
    return sortie;
  }, autre.origine);
  expect(JSON.stringify(issue.fetch)).not.toContain("200");
  expect(autre.requetes(), "l'autre origine ne reçoit RIEN").toEqual([]);
});
