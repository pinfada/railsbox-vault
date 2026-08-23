import { defineConfig } from "@playwright/test";

// Configuration distincte pour la preuve « intégration VM » (#4). Trois raisons :
//
// - elle démarre un vrai guest Linux : ses délais se comptent en dizaines de secondes, pas en
//   secondes, et imposer ce budget au harnais de base fausserait ses propres mesures ;
// - elle exige les artefacts v86 récupérés par `npm run vm:fetch`, donc un préalable réseau que
//   `npm run check` n'a pas ;
// - elle écrit ses artefacts ailleurs (`test-results/vm`) pour ne pas écraser ceux du harnais.
//
// Son serveur écoute sur un port qui lui est propre et n'est jamais réutilisé : une mesure de VM
// doit provenir de la coquille du dépôt, servie avec la CSP attendue.

export const VM_HOST = "127.0.0.1";
export const VM_PORT = 4176;

export default defineConfig({
  testDir: "tests/vm",
  fullyParallel: false,
  workers: 1,
  timeout: 600000,
  retries: 0,
  outputDir: "test-results/vm",
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: `http://${VM_HOST}:${VM_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node tools/serve.mjs --role shell --host ${VM_HOST} --port ${VM_PORT}`,
    port: VM_PORT,
    // Jamais de réutilisation : une mesure de VM doit provenir de cette coquille-ci, servie avec
    // cette CSP-ci. Un serveur étranger sur le port fausserait le relevé sans le dire.
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
