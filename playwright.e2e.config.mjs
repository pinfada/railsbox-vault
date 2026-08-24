import { defineConfig } from "@playwright/test";

// Configuration du scénario de sortie du MVP (#7) : « retrouver une mutation Rails après fermeture
// complète ». C'est le test du niveau le plus élevé du dépôt — une vraie application Rails boote sur
// un disque OPFS, on ferme tout, on coupe le réseau, et un boot à froid la retrouve.
//
// Il a sa propre configuration pour les mêmes raisons que `playwright.vm.config.mjs` :
//
// - il boote plusieurs fois un guest Linux i386 complet portant Rails : ses délais se comptent en
//   minutes, pas en secondes, et imposer ce budget au harnais de base fausserait ses mesures ;
// - il exige les artefacts de l'image de référence (`npm run image:build`) ET les artefacts v86
//   (`npm run vm:fetch`), donc des préalables Docker et réseau que `npm run check` n'a pas ;
// - il écrit ses artefacts et son rapport ailleurs (`test-results/e2e`, `reports/e2e`).
//
// Son serveur écoute sur un port qui lui est propre et n'est jamais réutilisé : une mesure de
// reprise doit provenir de la coquille du dépôt, servie avec sa CSP.

export const E2E_HOST = "127.0.0.1";
export const E2E_PORT = 4177;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Un scénario complet enchaîne préparation, boot à chaud, témoin négatif et trois boots à froid.
  timeout: 1_500_000,
  retries: 0,
  outputDir: "test-results/e2e",
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: `http://${E2E_HOST}:${E2E_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node tools/serve.mjs --role shell --host ${E2E_HOST} --port ${E2E_PORT}`,
    port: E2E_PORT,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
