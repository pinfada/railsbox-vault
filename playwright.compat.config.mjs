import { defineConfig } from "@playwright/test";

// Configuration distincte de `playwright.config.mjs` : la suite de compatibilité vise trois
// moteurs et a besoin d'un serveur isolé multi-origine (COOP/COEP) pour mesurer réellement
// SharedArrayBuffer et Atomics.wait. Le harnais `test:browser` reste sur Chromium et sur un
// serveur sans en-tête d'isolation, afin de ne pas changer ses conditions d'exécution.
const port = 4180;

export default defineConfig({
  testDir: "tests/compat",
  outputDir: "test-results/compat",
  fullyParallel: false,
  workers: 1,
  // La reprise n'existe qu'en CI, et elle est COMPTÉE (#178, décision du 10 septembre 2026). La
  // politique est la même pour les trois suites du gate : un rouge sans information, sur un
  // flottement du harnais que cinq campagnes de mesure n'ont pas su attribuer, bloquerait les
  // fusions sans rien apprendre à personne. Le rapport JSON va dans son propre fichier, et
  // `tools/compter-reprises.mjs` lit les trois pour publier le compte en nommant la suite d'origine.
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  reporter: process.env.CI
    ? [["list"], ["github"], ["json", { outputFile: "playwright-report/rapport-compat.json" }]]
    : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node tools/serve.mjs --port ${port} --cross-origin-isolated`,
    port,
    // Jamais de réutilisation : un rapport de compatibilité doit provenir de cette page-ci, servie
    // avec ces en-têtes-ci. Si le port est déjà pris, l'échec doit être bruyant plutôt que de
    // mesurer un serveur étranger.
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
