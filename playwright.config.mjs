import { defineConfig } from "@playwright/test";

import { APP_HOST, APP_PORT, SHELL_HOST, SHELL_PORT } from "./src/spike/origin-topology.mjs";

const MOTEURS_CONNUS = ["chromium", "firefox", "webkit"];

// Le harnais mesure une frontière d'origine : il lui faut DEUX serveurs, donc deux origines
// réelles. `127.0.0.1` et `localhost` en fournissent sans DNS ni certificat, et restent tous deux
// des contextes sécurisés.
const moteurs = (process.env.VAULT_MOTEURS ?? "chromium")
  .split(",")
  .map((nom) => nom.trim())
  .filter(Boolean);

for (const moteur of moteurs) {
  if (!MOTEURS_CONNUS.includes(moteur)) {
    throw new Error(
      `Moteur inconnu dans VAULT_MOTEURS : ${moteur}. Valeurs admises : ${MOTEURS_CONNUS.join(", ")}.`,
    );
  }
}

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  // Les relevés du spike #35 exécutent dix-neuf sondes dont plusieurs attendent volontairement un
  // silence de l'API (origine opaque) : le délai par défaut de 30 s ne leur suffit pas.
  timeout: 120000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: `http://${SHELL_HOST}:${SHELL_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node tools/serve.mjs --role shell --host ${SHELL_HOST} --port ${SHELL_PORT}`,
      url: `http://${SHELL_HOST}:${SHELL_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node tools/serve.mjs --role app --host ${APP_HOST} --port ${APP_PORT}`,
      url: `http://${APP_HOST}:${APP_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: moteurs.map((nom) => ({ name: nom, use: { browserName: nom } })),
});
