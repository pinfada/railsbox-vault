import { defineConfig } from "@playwright/test";

/**
 * Configuration du seul banc du spike #185. Elle vit ici et non à la racine : le spike ne rend
 * aucun code de produit, n'entre dans aucune suite du gate, et ne doit donc apparaître ni dans
 * `npm run check` ni dans `package.json`. Elle se lance explicitement :
 *
 *     npx playwright test --config tools/spike-gcm-siv/playwright.spike.config.mjs
 *
 * Aucun `webServer` : les modules sont servis par interception de route (voir la spécification).
 */
export default defineConfig({
  testDir: ".",
  testMatch: "banc-navigateur.spec.mjs",
  outputDir: "../../test-results/spike-gcm-siv",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: "list",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
