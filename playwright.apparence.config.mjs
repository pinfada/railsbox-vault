import { defineConfig } from "@playwright/test";

export const ORIGINE_APPARENCE = "http://127.0.0.1:4205";
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
  ],
});
