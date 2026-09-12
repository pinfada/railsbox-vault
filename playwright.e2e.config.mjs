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

/**
 * Le COUPLE de la coquille de produit (#163, ADR 0030, décision 2).
 *
 * Deux serveurs de plus, et non les deux existants : le scénario de la coquille a besoin d'un rôle
 * `shell` ET d'un rôle `app`, là où A et B sont tous deux des rôles `shell` — le rôle `app` ne sert
 * ni CSP ni COOP, et le rôle `shell` sert `frame-ancestors 'none'`, qui rendrait le document
 * applicatif INENCADRABLE. Changer le rôle de B aurait déplacé les en-têtes sous trois scénarios qui
 * n'ont rien demandé.
 *
 * Les ports suivent la règle que la coquille applique elle-même (`origines-de-la-coquille.mjs`) :
 * l'origine applicative est `localhost` sur le port SUIVANT. Ce n'est pas une convention d'épreuve,
 * c'est la règle du produit, et le scénario tomberait si elle changeait — ce qui est bien.
 */
export const E2E_COQUILLE_PORT = 4179;
export const E2E_COQUILLE_APP_PORT = 4180;
export const E2E_ORIGIN_COQUILLE = `http://${E2E_HOST}:${E2E_COQUILLE_PORT}`;
export const E2E_ORIGIN_COQUILLE_APP = `http://${E2E_HOST_B}:${E2E_COQUILLE_APP_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Un scénario complet enchaîne préparation, boot à chaud, témoin négatif et trois boots à froid.
  timeout: 1_500_000,
  retries: 0,
  outputDir: "test-results/e2e",
  // `list` est AJOUTÉ en intégration continue, et c'est la correction d'un défaut de lisibilité qui
  // a coûté cher : la recette a rendu « 8 passed, 1 skipped » sans dire lequel ni pourquoi, et le
  // scénario ignoré était celui que la tranche livrait. Le rapporteur `github`
  // n'imprime pas la sortie standard d'un scénario ; `list` le fait, et c'est par elle que
  // `exigerLesPrealables` nomme ce qui manque.
  // `blob`, pas `html` (#200) : la recette répartit les scénarios en deux lots (`reprise.yml`), et
  // chaque lot tourne sur son propre exécutant. Un `html` par lot ne servirait à rien — seul le
  // rapport FUSIONNÉ des deux compte —, alors que `blob` est le format que `playwright
  // merge-reports` sait combiner en un seul rapport HTML. `VAULT_E2E_LOT`, posé par le job du lot,
  // évite que les deux processus écrivent le même fichier avant la fusion.
  reporter: process.env.CI
    ? [
        ["list"],
        ["github"],
        [
          "blob",
          {
            outputFile: `blob-report/${process.env.VAULT_E2E_LOT ? `rapport-lot-${process.env.VAULT_E2E_LOT}` : "rapport"}.zip`,
          },
        ],
      ]
    : "list",
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
    // Le couple de la COQUILLE DE PRODUIT : origine de confiance et origine applicative, chacune
    // avec les en-têtes de son rôle. C'est la topologie de l'ADR 0002, servie pour de bon.
    {
      // `--app-origin` est OBLIGATOIRE ici, et son absence est la première chose que le scénario a
      // trouvée : la CSP de la coquille porte `frame-src 'self' <origine applicative>`, et sans ce
      // drapeau elle nomme l'origine par défaut du dépôt (`localhost:4174`) — le cadre vers
      // `localhost:4180` est alors refusé par la politique, et le document applicatif ne se charge
      // jamais. La frontière fonctionnait ; c'est le serveur qui ne servait pas la bonne.
      command: `node tools/serve.mjs --role shell --host ${E2E_HOST} --port ${E2E_COQUILLE_PORT} --app-origin ${E2E_ORIGIN_COQUILLE_APP}`,
      url: `${E2E_ORIGIN_COQUILLE}/index.html`,
      reuseExistingServer: false,
    },
    {
      command: `node tools/serve.mjs --role app --host ${E2E_HOST_B} --port ${E2E_COQUILLE_APP_PORT}`,
      url: `${E2E_ORIGIN_COQUILLE_APP}/document-applicatif.html`,
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
