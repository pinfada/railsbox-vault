import { defineConfig } from "@playwright/test";

// Configuration du spike #41 — coût de l'isolation multi-origine sur le runtime v86.
//
// Elle est distincte de toutes les autres pour trois raisons de MESURE, pas de commodité :
//
// - elle a besoin de DEUX serveurs simultanés servant le MÊME contenu, l'un nu et l'autre sous
//   COOP/COEP. Le paramètre `?isolation=require-corp` de `tools/serve.mjs` ne suffit pas : il ne
//   pose la politique que sur la réponse qui la porte, et le spike #35 a mesuré qu'un module de
//   Worker chargé sans elle est alors refusé. L'option `--cross-origin-isolated` la pose sur
//   TOUTES les réponses, ce qui est la condition de production à comparer ;
// - elle démarre de vrais guests Linux et télécharge des artefacts tiers (`npm run vm:fetch`) :
//   ses délais se comptent en minutes et elle n'a pas sa place dans `npm run check` ;
// - elle écrit ses artefacts ailleurs (`test-results/isolation`) pour ne rien écraser.
//
// Les trois moteurs de la matrice #2 sont déclarés. Un moteur qui ne peut pas porter le runtime
// sous la CSP de la coquille produit une RAISON typée dans son rapport ; il n'est pas retiré de la
// configuration, parce qu'une absence silencieuse ne se distingue pas d'un oubli.

export const ISOLATION_HOST = "127.0.0.1";
/** Serveur nu : aucun en-tête d'isolation, `crossOriginIsolated` faux. */
export const PORT_NU = 4184;
/** Serveur isolé : COOP `same-origin` + COEP `require-corp` sur toutes les réponses. */
export const PORT_ISOLE = 4185;

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

const serveur = (port, isole) => ({
  command: `node tools/serve.mjs --role shell --host ${ISOLATION_HOST} --port ${port}${
    isole ? " --cross-origin-isolated" : ""
  }`,
  url: `http://${ISOLATION_HOST}:${port}/`,
  // Jamais de réutilisation : la mesure ne vaut que si les en-têtes sont ceux de CE serveur-ci.
  // Un serveur étranger déjà posé sur le port fausserait le relevé sans le dire.
  reuseExistingServer: false,
});

export default defineConfig({
  testDir: "tests/isolation",
  outputDir: "test-results/isolation",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 1_800_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  webServer: [serveur(PORT_NU, false), serveur(PORT_ISOLE, true)],
  projects: moteurs.map((nom) => ({ name: nom, use: { browserName: nom } })),
});
