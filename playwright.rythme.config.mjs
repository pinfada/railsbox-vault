import { defineConfig } from "@playwright/test";

// Harnais de MESURE du rythme de l'émulateur (#74) : la boucle d'ordonnancement fournie par Vault
// coûte-t-elle du temps de boot à l'image de référence, comparée à celle du moteur ?
//
// Configuration distincte, pour les mêmes raisons que celles de `test:csp` et de `test:isolation` :
//
// - elle boote DIX fois une image Rails i386 complète : elle se compte en dizaines de minutes et
//   n'a sa place ni dans `npm run check` ni dans `npm run test:e2e`, dont elle doublerait la durée ;
// - elle exige les artefacts de `npm run image:build` ET de `npm run vm:fetch`, donc des préalables
//   Docker et réseau ;
// - elle écrit ses artefacts et son rapport ailleurs (`test-results/rythme`, `reports/rythme`).
//
// Son serveur a son propre port et n'est jamais réutilisé : une mesure de rythme doit provenir de la
// coquille du dépôt, servie avec sa CSP, et non d'un serveur étranger déjà posé sur le port.

export const RYTHME_HOST = "127.0.0.1";
export const RYTHME_PORT = 4179;

export default defineConfig({
  testDir: "tests/rythme",
  fullyParallel: false,
  // Un seul essai à la fois : deux guests concurrents mesureraient la contention de la machine.
  workers: 1,
  timeout: 3_600_000,
  retries: 0,
  outputDir: "test-results/rythme",
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://${RYTHME_HOST}:${RYTHME_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node tools/serve.mjs --role shell --host ${RYTHME_HOST} --port ${RYTHME_PORT}`,
    url: `http://${RYTHME_HOST}:${RYTHME_PORT}/vm/reference.html`,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
