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
  // Chromium porte TOUTE la suite : c'est le moteur où OPFS, la barrière de durabilité (#6, #14) et
  // la matrice de coupures de #15 (`resilience-arrets.spec.mjs`) sont mesurés. Cette dernière est
  // donc, elle aussi, une épreuve CHROMIUM SEULEMENT : elle ouvre un volume OPFS réel, et son
  // résultat n'est annoncé que pour ce moteur. Firefox et WebKit ne portent que le TÉMOIN de
  // démarrage sur les trois moteurs (#74) — les autres épreuves y échoueraient pour une raison déjà
  // mesurée et étrangère à l'ordonnancement : WebKit Playwright n'expose pas OPFS
  // (`VAULT_STORAGE_UNSUPPORTED`).
  //
  // Coût mesuré de cette extension : un boot de guest par moteur, artefacts compris.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "firefox",
      use: { browserName: "firefox" },
      testMatch: /boot-trois-moteurs\.spec\.mjs/,
    },
    {
      name: "webkit",
      use: { browserName: "webkit" },
      testMatch: /boot-trois-moteurs\.spec\.mjs/,
    },
  ],
});
