// Contextes d'exécution du banc : les `epreuves/*.mjs` sont du code NODE dont les rappels de
// `page.evaluate` s'exécutent dans le navigateur ; `pages/` et `banc/sw-modele.js` sont servis à la
// page, au Worker et au Service Worker. On étend la configuration du dépôt au lieu de la remplacer.
import globals from "globals";

import racine from "../../eslint.config.mjs";

export default [
  ...racine,
  {
    files: ["*.mjs", "banc/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["epreuves/**/*.mjs", "banc/cadre.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["pages/**/*.mjs"],
    ignores: ["pages/travailleur.mjs"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["pages/travailleur.mjs"],
    languageOptions: { globals: { ...globals.worker } },
  },
  {
    files: ["banc/sw-modele.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.serviceworker } },
  },
];
