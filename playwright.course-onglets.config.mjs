import { defineConfig } from "@playwright/test";

// LES COURSES ENTRE ONGLETS (#311, tranche C5 du lot C) — une configuration DISTINCTE.
//
// Le motif n'est pas la commodité : ces épreuves retiennent un Worker de produit à un instant précis,
// et le seul moyen qui marche sur les trois moteurs est un serveur de test qui sert une copie
// instrumentée de `openOpfsSyncAccess` (`tools/harnais-point-d-arret.mjs`). Ce serveur ne se lance
// que d'ici, par l'ARGUMENT `--harnais-point-d-arret` ; la configuration ordinaire ne le passe pas,
// et les suites ordinaires ne servent pas un octet de plus que le produit.
//
// Un serveur déjà lancé n'est JAMAIS réutilisé : un serveur ordinaire sur ce port ferait croire à une
// pause qui n'existe pas, et l'épreuve attendrait un signal qu'aucun Worker ne peut émettre.
//
// Les TROIS moteurs sont déclarés. WebKit n'a pas l'OPFS synchrone dans un Worker : les épreuves y
// exigent la limite typée au lieu de la sauter.

export const COURSE_HOTE = "127.0.0.1";
/** Coquille. Le port applicatif est le SUIVANT : c'est la règle de `origines-de-la-coquille.mjs`. */
export const COURSE_PORT = 4188;
export const COURSE_HOTE_APPLICATIF = "localhost";
export const COURSE_PORT_APPLICATIF = COURSE_PORT + 1;
export const COURSE_ORIGINE = `http://${COURSE_HOTE}:${COURSE_PORT}`;

const MOTEURS_CONNUS = ["chromium", "firefox", "webkit"];

const moteurs = (process.env.VAULT_MOTEURS ?? MOTEURS_CONNUS.join(","))
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

const serveur = (role, host, port, supplement = "") => ({
  command: `node tools/serve.mjs --role ${role} --host ${host} --port ${port}${supplement}`,
  url: `http://${host}:${port}/`,
  reuseExistingServer: false,
});

export default defineConfig({
  testDir: "tests/browser",
  testMatch: ["**/coquille-course-*.spec.mjs"],
  outputDir: "test-results/course-onglets",
  fullyParallel: false,
  // Un seul onglet de test à la fois : deux épreuves se disputeraient le même OPFS.
  workers: 1,
  timeout: 300_000,
  retries: 0,
  reporter: process.env.CI
    ? [
        ["list"],
        ["github"],
        ["json", { outputFile: "playwright-report/rapport-course-onglets.json" }],
      ]
    : "list",
  use: {
    baseURL: COURSE_ORIGINE,
    trace: "retain-on-failure",
    // Même borne de navigation que les autres configurations (#178).
    navigationTimeout: 60_000,
  },
  webServer: [
    serveur("shell", COURSE_HOTE, COURSE_PORT, " --alias localhost --harnais-point-d-arret"),
    serveur("app", COURSE_HOTE_APPLICATIF, COURSE_PORT_APPLICATIF),
  ],
  projects: moteurs.map((nom) => ({ name: nom, use: { browserName: nom } })),
});
