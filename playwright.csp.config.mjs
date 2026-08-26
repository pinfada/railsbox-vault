import { defineConfig } from "@playwright/test";

// Harnais de mesure de l'issue #52 — sous quelle CSP la boucle d'ordonnancement de v86 bat-elle ?
//
// Configuration distincte, pour les mêmes raisons que celle du spike #41 et non par commodité :
//
// - elle a besoin de DEUX serveurs simultanés servant le MÊME contenu, dont la CSP ne diffère que
//   par une directive : `worker-src 'self'` d'un côté, `worker-src 'self' blob:` de l'autre. C'est
//   le seul montage qui attribue un écart de démarrage à la CSP et à rien d'autre ;
// - elle démarre de vrais guests Linux et exige les artefacts de `npm run vm:fetch` : ses délais se
//   comptent en minutes et elle n'a pas sa place dans `npm run check`, qui n'a pas ce préalable ;
// - elle écrit ses artefacts ailleurs (`test-results/csp`) pour ne rien écraser.
//
// Les tests de FRONTIÈRE de la CSP, eux, sont rattachés à `npm run check` : ils n'ont besoin
// d'aucun artefact et vivent dans `tests/browser/csp-frontiere.spec.mjs`.
//
// Les trois moteurs de la matrice #2 sont déclarés. Un moteur qui ne peut pas porter le runtime
// produit une mesure — pas une absence : c'est précisément ce que #52 doit établir.

export const CSP_HOST = "127.0.0.1";
/** CSP de la coquille telle qu'elle est servie : `worker-src 'self'`. */
export const PORT_STRICT = 4186;
/** Même contenu, `worker-src 'self' blob:` — la politique élargie que l'ADR 0013 compare. */
export const PORT_BLOB = 4187;

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

const serveur = (port, blob) => ({
  command: `node tools/serve.mjs --role shell --host ${CSP_HOST} --port ${port}${
    blob ? " --worker-src-blob" : ""
  }`,
  url: `http://${CSP_HOST}:${port}/`,
  // Jamais de réutilisation : la mesure ne vaut que si la CSP est celle de CE serveur-ci. Un
  // serveur étranger déjà posé sur le port fausserait le relevé sans le dire.
  reuseExistingServer: false,
});

export default defineConfig({
  testDir: "tests/csp",
  outputDir: "test-results/csp",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  webServer: [serveur(PORT_STRICT, false), serveur(PORT_BLOB, true)],
  projects: moteurs.map((nom) => ({ name: nom, use: { browserName: nom } })),
});
