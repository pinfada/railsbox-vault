import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { platform, release } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * Banc du spike #185 sur les trois moteurs.
 *
 *     npx playwright test --config tools/spike-gcm-siv/playwright.spike.config.mjs
 *
 * Le verdict se prend ICI et non sous Node : l'ADR 0015 a mesuré que Node est ~2,8 fois plus lent
 * par appel à `crypto.subtle` que Chromium, et le point de comparaison publié — 17,3 µs par appel
 * AES-GCM sur 512 octets — est un chiffre de navigateur.
 *
 * Aucun serveur, aucun document ajouté au dépôt : les modules du spike sont servis par
 * interception de route, sur une origine `https://` fabriquée — donc un contexte sécurisé, donc
 * `crypto.subtle`. Le spike ne touche ni `public/`, ni `src/`, ni la chaîne de publication. La
 * contrepartie est écrite dans la note du spike : ce n'est pas l'origine du produit, et le banc ne
 * mesure donc pas ce que les en-têtes de la coquille coûtent — ils ne coûtent rien à un appel de
 * chiffrement, et les quatre séries sont de toute façon comparées ENTRE ELLES, dans le même
 * processus, sur les mêmes octets.
 */

const playwrightVersion = createRequire(import.meta.url)("@playwright/test/package.json").version;
const racineDuSpike = new URL("./", import.meta.url);
const racineCandidate = new URL("../../reports/spike-gcm-siv/candidate/", import.meta.url);
const dossierDeRapport = fileURLToPath(new URL("../../reports/spike-gcm-siv/", import.meta.url));

const ORIGINE = "https://banc-siv.test";

/**
 * Cadence réglable par l'environnement. Le LOT n'est plus fixé : chaque série le calibre pour que
 * son bloc chronométré dure au moins `cibleMs`, ce qui met la quantification du chronomètre
 * au-dessous de deux pour cent sur les trois moteurs — ils n'ont pas la même résolution. Le lot
 * retenu est publié avec chaque série dans le rapport JSON.
 */
const CADENCE = {
  essais: Number.parseInt(process.env.VAULT_SPIKE_ESSAIS ?? "7", 10),
  cibleMs: Number.parseInt(process.env.VAULT_SPIKE_CIBLE_MS ?? "60", 10),
  lotMaximum: Number.parseInt(process.env.VAULT_SPIKE_LOT_MAX ?? "8192", 10),
};

/** Les modules servis, et rien d'autre : une route qui ne les nomme pas rend 404. */
const MODULES = new Map([
  ["/banc-commun.mjs", new URL("banc-commun.mjs", racineDuSpike)],
  ["/gcm-siv-webcrypto.mjs", new URL("gcm-siv-webcrypto.mjs", racineDuSpike)],
  ["/polyval.mjs", new URL("polyval.mjs", racineDuSpike)],
  ["/octets.mjs", new URL("octets.mjs", racineDuSpike)],
  ["/candidate/aes.js", new URL("aes.js", racineCandidate)],
  ["/candidate/utils.js", new URL("utils.js", racineCandidate)],
  ["/candidate/_polyval.js", new URL("_polyval.js", racineCandidate)],
]);

async function candidateDisponible() {
  try {
    await readFile(fileURLToPath(new URL("aes.js", racineCandidate)));
    return true;
  } catch {
    return false;
  }
}

async function installerLesRoutes(page) {
  await page.route(`${ORIGINE}/**`, async (route) => {
    const chemin = new URL(route.request().url()).pathname;
    if (chemin === "/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>banc AES-GCM-SIV</title></head><body></body></html>',
      });
      return;
    }
    const fichier = MODULES.get(chemin);
    if (!fichier) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain; charset=utf-8",
        body: "absent",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(fileURLToPath(fichier), "utf8"),
    });
  });
}

test.describe("spike #185 — coût d'AES-GCM-SIV par secteur", () => {
  test("les quatre séries sont mesurées sur ce moteur", async ({
    page,
    browser,
    browserName,
  }, testInfo) => {
    test.setTimeout(600_000);
    const avecCandidate = await candidateDisponible();
    await installerLesRoutes(page);
    await page.goto(`${ORIGINE}/`);

    expect(
      await page.evaluate(() => globalThis.isSecureContext),
      "contexte non sécurisé : crypto.subtle serait absent",
    ).toBe(true);

    const mesure = await page.evaluate(
      async ({ avec, cadence }) => {
        const banc = await import("/banc-commun.mjs");
        const candidate = avec ? await import("/candidate/aes.js") : null;
        return banc.mesurer({ ...cadence, candidate });
      },
      { avec: avecCandidate, cadence: CADENCE },
    );

    const rapport = {
      contrat: { id: "railsbox-vault-spike-gcm-siv-banc", version: 1 },
      issue: 185,
      moteur: browserName,
      versionMoteur: browser.version(),
      playwright: playwrightVersion,
      systeme: `${platform()} ${release()}`,
      node: process.version,
      releveLe: new Date().toISOString(),
      ...mesure,
      candidate: avecCandidate ? "@noble/ciphers, préparée et vérifiée par empreinte" : "absente",
    };
    const serialise = `${JSON.stringify(rapport, null, 2)}\n`;

    await mkdir(dossierDeRapport, { recursive: true });
    await writeFile(`${dossierDeRapport}banc-${browserName}.json`, serialise, "utf8");
    await testInfo.attach(`banc-gcm-siv-${browserName}.json`, {
      body: serialise,
      contentType: "application/json",
    });

    for (const serie of mesure.series) {
      // Une série qui rend zéro n'a pas été chronométrée : `performance.now` bridé ou lot trop
      // court. Le banc doit rougir plutôt que publier un coût nul.
      expect(serie.mediane, `série ${serie.nom} sans durée mesurable`).toBeGreaterThan(0);
      console.log(
        `${browserName.padEnd(8)} ${serie.nom.padEnd(26)} médiane ${serie.mediane.toFixed(1).padStart(8)} µs/scellement   étendue ${(serie.etendueRelative * 100).toFixed(0)} %`,
      );
    }
    console.log(
      `${browserName} — appels à crypto.subtle par scellement SIV composé : ${mesure.appelsSubtleParScellementSiv}`,
    );
  });
});
