// DEUX COFFRES, UN SEUL SERVICE WORKER (revue de sécurité de la PR #203, constats 1 et 2).
//
// Le Service Worker de la coquille de cadre est UNIQUE pour l'origine applicative ; les courtiers,
// un par coquille ouverte. Il relayait par « le premier courtier trouvé » : la page du coffre B était
// servie par le port restreint, le Worker, le guest et le bocal à cookies du coffre A. Et un onglet
// ouvert à la main sur le chemin du courtier rendait le relais muet soixante-quinze secondes.
//
// Ce que cette suite mesure, sans machine virtuelle et sur les trois moteurs : le relevé de CHAQUE
// coquille compte les requêtes que SON relais a portées. Aucune action faite dans le coffre B, dans
// un onglet hors coffre ou dans un leurre ne fait bouger le compte du coffre A.

import { expect, test } from "../support/test.mjs";

import { ENTETES_DE_L_HEBERGEUR_APPLICATIF } from "../../src/coquille/relais-http.mjs";
import { APP_ORIGIN, SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/**
 * WebKit est DÉCLARÉ, pas mesuré : la coquille n'y va pas jusqu'au cadre applicatif (pas d'OPFS
 * sous ce moteur, `docs/compatibility.md`), il n'y a donc ni courtier ni Service Worker à router.
 */
const SANS_COURTIER_SOUS_WEBKIT =
  "WebKit : la coquille s'arrête avant le cadre (OPFS absent), il n'y a aucun courtier à router.";

async function ouvrirUneCoquille(contexte) {
  const page = await contexte.newPage();
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString());
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60000 });
  return page;
}

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

const courtier = (page) => page.frameLocator("#document-applicatif");
const cadreServi = (page) => courtier(page).frameLocator("#application-servie");

async function releveDuCourtier(page) {
  return JSON.parse(await courtier(page).locator("#document-applicatif-rapport").textContent());
}

/** Attend que la coquille de cadre soit active et que son cadre montre la page d'ATTENTE. */
async function attendreLAttente(page) {
  await expect
    .poll(async () => (await releveDuCourtier(page)).coquilleDeCadre?.serviceWorker, {
      timeout: 60000,
    })
    .toBe("actif");
  await expect(cadreServi(page).locator("html")).toHaveAttribute("data-cadre", "attente", {
    timeout: 60000,
  });
}

test("deux coffres ouverts : le relais du coffre A ne porte JAMAIS une requête du coffre B", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", SANS_COURTIER_SOUS_WEBKIT);
  const coffreA = await ouvrirUneCoquille(context);
  await attendreLAttente(coffreA);
  // UNE question — la première page — puis plus rien : le courtier attend le démarrage.
  const demandeesParA = (await releve(coffreA)).relais.demandees;
  expect(demandeesParA).toBe(1);

  // 1. Le coffre B s'ouvre. Sa première navigation trouve DEUX courtiers : elle est REFUSÉE, et le
  //    refus se lit dans le cadre — elle n'est jamais servie par A.
  const coffreB = await ouvrirUneCoquille(context);
  await expect(cadreServi(coffreB).locator("html")).toHaveAttribute(
    "data-cadre-code",
    "CADRE_COURTIERS_MULTIPLES",
    { timeout: 60000 },
  );
  expect((await releve(coffreB)).relais.demandees).toBe(0);
  expect((await releve(coffreA)).relais.demandees).toBe(demandeesParA);

  // 2. Une sous-ressource du cadre de B : son client n'est lié à aucun courtier, elle est refusée.
  const depuisB = await cadreServi(coffreB)
    .locator("html")
    .evaluate(async () => {
      const reponse = await fetch("/sonde-du-coffre-b");
      return { statut: reponse.status, texte: await reponse.text() };
    });
  expect(depuisB.statut).toBe(504);
  expect(depuisB.texte).toContain("CADRE_CLIENT_SANS_COURTIER");
  expect((await releve(coffreA)).relais.demandees).toBe(demandeesParA);

  // 3. Une sous-ressource du cadre de A, pendant que B est ouvert : elle suit la LIAISON de son
  //    client, et c'est le courtier de A qui la reçoit — il répond « en attente » sans rien relayer.
  const depuisA = await cadreServi(coffreA)
    .locator("html")
    .evaluate(async () => {
      const reponse = await fetch("/sonde-du-coffre-a");
      return {
        statut: reponse.status,
        texte: await reponse.text(),
        entetes: Object.fromEntries(reponse.headers),
      };
    });
  expect(depuisA.statut).toBe(503);
  expect(depuisA.texte).toContain("pas encore démarrée");
  // Ce que le Service Worker SERT porte les en-têtes de politique de l'hébergeur : le témoin mesure
  // ici un chemin qui ne va jamais au serveur (revue de sécurité de la PR #203, constat 7).
  for (const [nom, valeur] of Object.entries(ENTETES_DE_L_HEBERGEUR_APPLICATIF)) {
    expect(depuisA.entetes[nom.toLowerCase()], nom).toBe(valeur);
  }

  // 4. Un onglet HORS de tout coffre sur l'origine applicative (reproduction A du constat 1) : sa
  //    navigation part au réseau, et son `fetch` est refusé. Le coffre A ne compte rien.
  const horsCoffre = await context.newPage();
  const navigation = await horsCoffre.goto(new URL("/sonde-de-revue-203", APP_ORIGIN).toString());
  expect(navigation?.status()).toBe(404);
  const depuisLOnglet = await horsCoffre.evaluate(async () => (await fetch("/x")).status);
  // Deux issues honnêtes, selon le moteur, et aucune n'est « servi par A » : Chromium contrôle
  // l'onglet et le Service Worker REFUSE (504, client sans courtier) ; Firefox PARTITIONNE le Service
  // Worker enregistré sous la coquille, l'onglet de premier rang n'en a donc aucun, et la requête
  // part au réseau (404 du serveur statique).
  expect([504, 404]).toContain(depuisLOnglet);
  expect((await releve(coffreA)).relais.demandees).toBe(demandeesParA);
  await horsCoffre.close();
  await coffreB.close();
});

test("un onglet ouvert à la main sur le chemin du courtier n'est PAS un courtier (constat 2)", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", SANS_COURTIER_SOUS_WEBKIT);
  const coffre = await ouvrirUneCoquille(context);
  await attendreLAttente(coffre);
  const leurre = await context.newPage();
  await leurre.goto(new URL("/document-applicatif.html", APP_ORIGIN).toString());

  // Le cadre du coffre se recharge : avec le leurre ouvert, il est toujours servi par SON courtier,
  // et vite — le leurre répond « sans port », il ne fait attendre personne soixante-quinze secondes.
  const depart = Date.now();
  await cadreServi(coffre)
    .locator("html")
    .evaluate((racine) => racine.ownerDocument.defaultView.location.reload());
  await expect(cadreServi(coffre).locator("html")).toHaveAttribute("data-cadre", "attente", {
    timeout: 30000,
  });
  expect(Date.now() - depart).toBeLessThan(15000);
  await leurre.close();
});
