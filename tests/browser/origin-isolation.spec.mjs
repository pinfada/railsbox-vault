// Spike #35 — contraintes d'environnement de la topologie : CSP réellement servie et appliquée,
// isolation cross-origin (COOP/COEP) et effet de `require-corp` sur une iframe inter-origine.

import { expect, test } from "@playwright/test";

import { APP_PATH, SHELL_ORIGIN, SHELL_PATH } from "../../src/spike/origin-topology.mjs";
import { TOPOLOGIE_RETENUE, ouvrirCoquille, releverCoquille } from "./origin-helpers.mjs";

/**
 * Publie une mesure dans le rapport Playwright plutôt que sur la sortie standard : un relevé brut
 * imprimé à chaque exécution polluerait le journal de toutes les PR. Les mesures de référence du
 * spike sont figées dans `docs/spikes/0035-topologie-origine-de-confiance.md`.
 */
function joindre(info, nom, valeur) {
  return info.attach(`${nom}-${info.project.name}.json`, {
    body: JSON.stringify(valeur, null, 2),
    contentType: "application/json",
  });
}

test("la CSP est servie sur la coquille et absente du territoire applicatif", async ({
  request,
}) => {
  const coquille = await request.get(`${SHELL_ORIGIN}${SHELL_PATH}`);
  const politique = coquille.headers()["content-security-policy"];
  expect(politique).toContain("default-src 'none'");
  expect(politique).toContain("frame-ancestors 'none'");
  expect(politique).toContain("frame-src 'self' http://localhost:4174");

  const application = await request.get(`${SHELL_ORIGIN}${APP_PATH}`);
  expect(application.headers()["content-security-policy"]).toBeUndefined();
});

test("la CSP de la coquille refuse une origine absente de frame-src", async ({ page }, info) => {
  await ouvrirCoquille(page, TOPOLOGIE_RETENUE, { sondeCsp: true });
  await expect
    .poll(async () => (await releverCoquille(page)).violationsCsp.length, { timeout: 10000 })
    .toBeGreaterThan(0);

  const coquille = await releverCoquille(page);
  await joindre(info, "violations-csp", coquille.violationsCsp);
  expect(coquille.violationsCsp.map((violation) => violation.directive)).toContain("frame-src");
});

// Les trois épreuves qui suivent MESURENT sur tout moteur mais n'ASSERTENT que sous Chromium :
// COOP/COEP et la politique de permission `cross-origin-isolated` divergent d'un moteur à l'autre,
// et ces écarts sont consignés dans `docs/spikes/0035-topologie-origine-de-confiance.md` plutôt
// que transformés en échec. La matrice de support reste l'objet de l'issue #2.
const MOTEUR_DE_REFERENCE = "chromium";
const RAISON_ECART =
  "écart de moteur mesuré et consigné dans docs/spikes/0035-topologie-origine-de-confiance.md";

/**
 * Attend l'acquittement du Worker runtime, et rend le relevé même s'il n'arrive jamais : sous
 * certains moteurs `require-corp` empêche le chargement du Worker, et ce silence est lui-même une
 * mesure à publier plutôt qu'une erreur à masquer.
 */
async function attendreWorker(page, delaiMs = 10000) {
  const echeance = Date.now() + delaiMs;
  for (;;) {
    const releve = await releverCoquille(page);
    if (releve.isolationWorker !== null || Date.now() >= echeance) return releve;
    await page.waitForTimeout(200);
  }
}

test("sans COOP/COEP la coquille n'est pas isolée ; avec, la page et son Worker le sont", async ({
  page,
  browserName,
}, info) => {
  await ouvrirCoquille(page, TOPOLOGIE_RETENUE);
  const nu = await releverCoquille(page);

  await ouvrirCoquille(page, TOPOLOGIE_RETENUE, { isolation: "require-corp" });
  const isole = await attendreWorker(page);

  await joindre(info, "isolation", {
    nu: { page: nu.isolationPage, worker: nu.isolationWorker },
    isole: { page: isole.isolationPage, worker: isole.isolationWorker },
  });

  test.skip(browserName !== MOTEUR_DE_REFERENCE, RAISON_ECART);
  expect(nu.isolationPage.crossOriginIsolated).toBe(false);
  expect(isole.isolationPage.crossOriginIsolated).toBe(true);
  expect(isole.isolationPage.sharedArrayBuffer).toBe("alloue");
  expect(isole.isolationWorker.crossOriginIsolated).toBe(true);
  expect(isole.isolationWorker.sharedArrayBuffer).toBe("alloue");
});

test("sous require-corp, une iframe inter-origine sans COEP est refusée", async ({
  page,
  browserName,
}, info) => {
  const echecs = [];
  page.on("requestfailed", (requete) => {
    echecs.push(`${requete.url()} → ${requete.failure()?.errorText ?? "sans motif"}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") echecs.push(`console: ${message.text()}`);
  });

  await ouvrirCoquille(page, TOPOLOGIE_RETENUE, {
    isolation: "require-corp",
    isolationCadre: "aucune",
  });
  await expect(page.frameLocator("#app-frame").locator("#app-status")).toHaveCount(0, {
    timeout: 8000,
  });
  await joindre(info, "coep-refus", echecs);

  test.skip(browserName !== MOTEUR_DE_REFERENCE, RAISON_ECART);
  expect(echecs.join(" ")).toContain("app.html");
});

// L'isolation cross-origin est une fonctionnalité pilotée par permission dont la liste par défaut
// est `self` : une iframe INTER-ORIGINE ne l'hérite pas tant que la coquille ne pose pas
// `allow="cross-origin-isolated"`. La coquille garde donc SharedArrayBuffer pour son runtime et le
// refuse au code applicatif, sans rien faire de particulier. Cette épreuve fige ce comportement.
test("sous require-corp, l'iframe inter-origine charge sans hériter de l'isolation", async ({
  page,
  browserName,
}, info) => {
  const journal = [];
  page.on("console", (message) => {
    if (message.type() === "error") journal.push(message.text());
  });
  page.on("requestfailed", (requete) => {
    journal.push(`${requete.url()} → ${requete.failure()?.errorText ?? "sans motif"}`);
  });

  await ouvrirCoquille(page, TOPOLOGIE_RETENUE, { isolation: "require-corp" });
  const cadre = page.frameLocator("#app-frame");
  // Attendre la FIN des sondes, pas seulement l'existence de l'élément : `#app-isolation` vaut
  // « {} » tant que le module applicatif n'a pas été évalué, et lire trop tôt donnerait un relevé
  // vide que l'on prendrait pour une mesure.
  const charge = await expect(cadre.locator("#app-status"))
    .toHaveText(/sondes-terminees/, { timeout: 20000 })
    .then(async () => JSON.parse(await cadre.locator("#app-isolation").textContent()))
    .catch((erreur) => ({ chargement: `${erreur.name}: cadre non chargé`, journal }));
  await joindre(info, "coep-cadre", charge);

  test.skip(browserName !== MOTEUR_DE_REFERENCE, RAISON_ECART);
  expect(charge.crossOriginIsolated).toBe(false);
  expect(charge.sharedArrayBuffer).not.toBe("alloue");
});
