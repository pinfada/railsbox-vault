import eslint from "@eslint/js";
import globals from "globals";

// Le dépôt exécute son code dans cinq contextes distincts : page, Worker dédié, Service Worker,
// module partagé page/Worker, et Node. Fusionner leurs globals masquerait exactement les erreurs
// que le lint doit trouver — un appel Node dans un module servi au navigateur, une API DOM dans un
// Worker. Chaque bloc ci-dessous n'accorde donc que les globals de son contexte.
//
// Le contexte se déduit du répertoire puis du nom du fichier. C'est déjà la convention du dépôt
// (`compat-worker.mjs`, `worker-probe.mjs`, `page-probe.mjs`, `app-hostile-sw.mjs`) et elle reste
// vérifiable à l'œil. `docs/development.md` la documente pour les modules à venir.

/** Modules chargés dans un Worker dédié : aucun DOM, mais les globals propres au Worker. */
const WORKER_FILES = ["public/**/*worker*.mjs", "src/**/*worker*.mjs"];

/** Service Workers : encore un autre contexte (`clients`, `skipWaiting`), sans DOM non plus. */
const SERVICE_WORKER_FILES = ["public/**/*-sw.mjs"];

/** Documents et scripts de page servis tels quels, plus les modules `src/` réservés à la page. */
const PAGE_FILES = ["public/**/*.mjs", "src/**/page-*.mjs"];

/** Modules de contrat de `src/`, partagés par défaut entre la page et le Worker. */
const SHARED_WEB_FILES = ["src/**/*.mjs"];

/** Code exécuté par Node : outillage, suite unitaire et configurations à la racine. */
const NODE_FILES = ["tools/**/*.mjs", "tests/unit/**/*.mjs", "*.config.mjs"];

// Spécifications Playwright : le corps du test s'exécute sous Node, mais les rappels passés à
// `page.evaluate` sont du code navigateur analysé dans le même fichier. Les deux jeux sont donc
// légitimes ici ; les couvrir par des commentaires `/* global */` reviendrait à désactiver la règle.
const PLAYWRIGHT_FILES = ["tests/browser/**/*.mjs", "tests/compat/**/*.mjs"];

/**
 * Globals communs à la page et au Worker dédié. Les modules de `src/` sont importés par les deux
 * contextes : leur accorder tout `browser` laisserait passer un `document` qui casserait le Worker
 * à l'exécution, et tout `worker` laisserait passer un `importScripts` absent de la page.
 */
const SHARED_WEB_GLOBALS = Object.freeze(
  Object.fromEntries(Object.entries(globals.browser).filter(([nom]) => nom in globals.worker)),
);

export default [
  {
    ignores: [
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "reports/**",
      // Artefacts tiers récupérés par `npm run vm:fetch` : ils sont vérifiés par empreinte, pas
      // relus par notre linter. Les modifier reviendrait à casser cette vérification.
      "vendor/v86/artefacts/**",
    ],
  },
  eslint.configs.recommended,
  {
    // Le dépôt n'écrit qu'en `.mjs` ; les blocs par contexte ne ciblent donc que cette extension.
    // Un futur `.js` reste analysé comme un module mais sans aucun global : l'échec est bruyant et
    // oblige à le rattacher explicitement à un contexte plutôt qu'à hériter d'un jeu par défaut.
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  {
    // Placé avant les blocs page et Worker : ceux-ci n'ajoutent ensuite que ce que leur contexte
    // possède en propre, l'intersection étant incluse dans les deux.
    files: SHARED_WEB_FILES,
    languageOptions: { globals: SHARED_WEB_GLOBALS },
  },
  {
    // Les globals d'ESLint s'additionnent entre blocs : les contextes sans DOM doivent donc être
    // exclus ici, faute de quoi `document` resterait déclaré dans un Worker de `public/`.
    files: PAGE_FILES,
    ignores: [...WORKER_FILES, ...SERVICE_WORKER_FILES],
    languageOptions: { globals: globals.browser },
  },
  {
    files: WORKER_FILES,
    languageOptions: { globals: globals.worker },
  },
  {
    files: SERVICE_WORKER_FILES,
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: NODE_FILES,
    languageOptions: { globals: globals.node },
  },
  {
    files: PLAYWRIGHT_FILES,
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
