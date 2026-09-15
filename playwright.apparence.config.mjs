import { defineConfig } from "@playwright/test";

export const ORIGINE_APPARENCE = "http://127.0.0.1:4205";
// Les étapes 4 prête à 9, `forced-colors` et le mouvement non réduit sont joués sur Chromium seul
// (revue de la PR #216, constats 2 et 3) : Firefox n'atteint pas l'étape 4, WebKit ne crée aucun coffre.
const CHROMIUM_SEUL = /parcours-etapes\.spec\.mjs/;

export default defineConfig({
  testDir: "tests/apparence",
  timeout: 120_000,
  workers: 2,
  retries: 0,
  outputDir: "test-results/apparence",
  reporter: [["list"], ["json", { outputFile: "reports/apparence/resultats.json" }]],
  use: { baseURL: ORIGINE_APPARENCE, trace: "retain-on-failure" },
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
    testIgnore: browserName === "chromium" ? undefined : CHROMIUM_SEUL,
  })),
  webServer: [
    {
      command:
        "node tools/serve.mjs --role shell --host 127.0.0.1 --port 4205 --app-origin http://localhost:4206",
      url: `${ORIGINE_APPARENCE}/index.html`,
      reuseExistingServer: false,
    },
    {
      command: "node tools/serve.mjs --role app --host localhost --port 4206",
      url: "http://localhost:4206/document-applicatif.html",
      reuseExistingServer: false,
    },
    // La coquille B : l'autre appareil où la sauvegarde est restaurée (étape 7).
    {
      command:
        "node tools/serve.mjs --role shell --host 127.0.0.1 --port 4207 --app-origin http://localhost:4208",
      url: "http://127.0.0.1:4207/index.html",
      reuseExistingServer: false,
    },
    {
      command: "node tools/serve.mjs --role app --host localhost --port 4208",
      url: "http://localhost:4208/document-applicatif.html",
      reuseExistingServer: false,
    },
  ],
});
