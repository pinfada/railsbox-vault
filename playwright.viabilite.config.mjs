import { defineConfig } from "@playwright/test";
import configuration from "./playwright.e2e.config.mjs";

// Une recette de produit sur Chrome installé, avec le profil OPFS persistant de l'E2E.
// Une dépendance absente échoue : une qualification ne peut pas ignorer son scénario principal.
process.env.VAULT_E2E_EXIGER = "1";

export default defineConfig({
  ...configuration,
  testMatch: ["parcours-utilisateur.spec.mjs", "portabilite-coquille.spec.mjs"],
  outputDir: "test-results/viabilite",
  reporter: [["list"], ["json", { outputFile: "reports/viabilite/resultats.json" }]],
  projects: [{ name: "google-chrome", use: { browserName: "chromium", channel: "chrome" } }],
});
