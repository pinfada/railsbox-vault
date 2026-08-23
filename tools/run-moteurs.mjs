// Rejoue la suite navigateur sur plusieurs moteurs sans dépendre de la syntaxe d'affectation de
// variable d'environnement du shell : `VAULT_MOTEURS=… npx playwright test` ne fonctionne pas sous
// PowerShell, et le dépôt se développe sous Windows autant que sous Linux.
//
// Usage : node tools/run-moteurs.mjs [moteurs séparés par des virgules] [-- arguments Playwright]

import { spawnSync } from "node:child_process";

const [premier, ...reste] = process.argv.slice(2);
const separateur = reste.indexOf("--");
const moteurs = premier && !premier.startsWith("-") ? premier : "chromium,firefox,webkit";
const argumentsPlaywright = separateur >= 0 ? reste.slice(separateur + 1) : reste;

const resultat = spawnSync("npx", ["playwright", "test", ...argumentsPlaywright], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VAULT_MOTEURS: moteurs },
});

if (resultat.error) throw resultat.error;
process.exit(resultat.status ?? 1);
