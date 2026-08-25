import { defineConfig } from "@playwright/test";

// Configuration du scénario de sortie du MVP (#7) : « retrouver une mutation Rails après fermeture
// complète ». C'est le test du niveau le plus élevé du dépôt — une vraie application Rails boote sur
// un disque OPFS, on ferme tout, on coupe le réseau, et un boot à froid la retrouve.
//
// Il a sa propre configuration pour les mêmes raisons que `playwright.vm.config.mjs` :
//
// - il boote plusieurs fois un guest Linux i386 complet portant Rails : ses délais se comptent en
//   minutes, pas en secondes, et imposer ce budget au harnais de base fausserait ses mesures ;
// - il exige les artefacts de l'image de référence (`npm run image:build`) ET les artefacts v86
//   (`npm run vm:fetch`), donc des préalables Docker et réseau que `npm run check` n'a pas ;
// - il écrit ses artefacts et son rapport ailleurs (`test-results/e2e`, `reports/e2e`).
//
// Son serveur écoute sur un port qui lui est propre et n'est jamais réutilisé : une mesure de
// reprise doit provenir de la coquille du dépôt, servie avec sa CSP.
//
// DEUX origines sont servies depuis #12 (« restaurer un volume depuis une autre origine »). OPFS est
// cloisonné PAR ORIGINE : sans deux origines réellement distinctes, un « import » ne prouverait rien
// — il relirait le stockage qu'il vient d'écrire. `127.0.0.1` et `localhost` désignent la même
// interface de bouclage mais forment deux origines distinctes au sens du navigateur, et les ports
// diffèrent aussi ; c'est le même procédé que le spike d'origine de l'ADR 0002, sans DNS ni
// certificat.
//
// Chaque serveur est lié au NOM D'HÔTE par lequel le navigateur le visitera, et son attente porte
// sur l'URL complète, non sur un numéro de port : si `localhost` résolvait `::1` alors que le
// serveur n'écoute que sur `127.0.0.1`, une attente de port réussirait pendant que le navigateur
// échouerait — et TOUTE la suite tomberait en délai, y compris les scénarios existants.

export const E2E_HOST = "127.0.0.1";
export const E2E_HOST_B = "localhost";
export const E2E_PORT = 4177;
export const E2E_PORT_B = 4178;

/** Origine d'EXPORT : celle qui détient le volume d'origine. */
export const E2E_ORIGIN_A = `http://${E2E_HOST}:${E2E_PORT}`;
/** Origine de RESTAURATION : un stockage OPFS entièrement distinct de celui de A. */
export const E2E_ORIGIN_B = `http://${E2E_HOST_B}:${E2E_PORT_B}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Un scénario complet enchaîne préparation, boot à chaud, témoin négatif et trois boots à froid.
  timeout: 1_500_000,
  retries: 0,
  outputDir: "test-results/e2e",
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: E2E_ORIGIN_A,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node tools/serve.mjs --role shell --host ${E2E_HOST} --port ${E2E_PORT}`,
      url: `${E2E_ORIGIN_A}/vm/reference.html`,
      reuseExistingServer: false,
    },
    {
      command: `node tools/serve.mjs --role shell --host ${E2E_HOST_B} --port ${E2E_PORT_B}`,
      url: `${E2E_ORIGIN_B}/vm/reference.html`,
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
