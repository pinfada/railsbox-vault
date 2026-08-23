import { defineConfig } from "@playwright/test";

// Configuration distincte de `playwright.config.mjs` : la suite de compatibilité vise trois
// moteurs et a besoin d'un serveur isolé multi-origine (COOP/COEP) pour mesurer réellement
// SharedArrayBuffer et Atomics.wait. Le harnais `test:browser` reste sur Chromium et sur un
// serveur sans en-tête d'isolation, afin de ne pas changer ses conditions d'exécution.
const port = 4174;

export default defineConfig({
  testDir: "tests/compat",
  outputDir: "test-results/compat",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node tools/serve.mjs --port ${port} --cross-origin-isolated`,
    port,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
