import { defineConfig } from "@playwright/test";

import {
  ORIGINE_APPLICATIVE_B_HOTE,
  ORIGINE_APPLICATIVE_B_PORT,
  ORIGINE_APPLICATIVE_C_HOTE,
  ORIGINE_APPLICATIVE_C_PORT,
} from "./public/spike/origin/apps-topologie.mjs";
import { APP_HOST, APP_PORT, SHELL_HOST, SHELL_PORT } from "./src/spike/origin-topology.mjs";

const MOTEURS_CONNUS = ["chromium", "firefox", "webkit"];

/**
 * Épreuves de frontière de la CSP et du diagnostic qu'elle commande (#52) : exécutées sur les trois
 * moteurs, jamais sur un seul. Une politique de sécurité ne s'applique pas de la même façon d'un
 * moteur à l'autre, et le diagnostic du runtime dépend de ce que chacun expose.
 *
 * Depuis #74, la famine des minuteries sous la boucle d'ordonnancement de Vault rejoint la liste,
 * pour la même raison : elle mesure un comportement d'ORDONNANCEMENT qui diffère d'un moteur à
 * l'autre — mesuré, WebKit affame ses minuteries là où Chromium et Firefox ne le font pas — et dont
 * dépend la cadence du chien de garde du runtime.
 */
const FRONTIERE_CSP = [
  "**/csp-frontiere.spec.mjs",
  "**/runtime-diagnostic.spec.mjs",
  "**/ordonnancement-famine.spec.mjs",
];

/**
 * Frontière entre deux applications partageant l'origine applicative (#46, ADR 0018). Exécutée sur
 * les trois moteurs pour le même motif que la frontière de CSP, et pour un motif de plus : le
 * partitionnement du stockage n'est pas identique d'un moteur à l'autre — l'OPFS et
 * `indexedDB.databases` manquent à certains —, si bien qu'un relevé mono-moteur publierait une
 * garantie que les deux autres ne tiendraient peut-être pas.
 */
const FRONTIERE_APPLICATIONS = ["**/apps-frontiere.spec.mjs"];

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
    // Seconde origine APPLICATIVE (#46). L'hôte change, et pas seulement le port : les cookies
    // ignorent le port, et deux origines qui n'en différeraient que par lui partageraient leur
    // bocal — la mesure conclurait à une isolation que la topologie visée n'aurait pas non plus.
    {
      command: `node tools/serve.mjs --role app --host ${ORIGINE_APPLICATIVE_B_HOTE} --port ${ORIGINE_APPLICATIVE_B_PORT}`,
      url: `http://${ORIGINE_APPLICATIVE_B_HOTE}:${ORIGINE_APPLICATIVE_B_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    // Troisième origine applicative (#46), sur le MÊME hôte que la première et n'en différant que
    // par le port : elle mesure l'écart entre la frontière d'origine, qui compte le port, et la
    // frontière de cookies, qui ne le compte pas.
    {
      command: `node tools/serve.mjs --role app --host ${ORIGINE_APPLICATIVE_C_HOTE} --port ${ORIGINE_APPLICATIVE_C_PORT}`,
      url: `http://${ORIGINE_APPLICATIVE_C_HOTE}:${ORIGINE_APPLICATIVE_C_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    ...moteurs.map((nom) => ({
      name: nom,
      use: { browserName: nom },
      testIgnore: [...FRONTIERE_CSP, ...FRONTIERE_APPLICATIONS],
    })),
    // La frontière de CSP (#52) est une frontière de SÉCURITÉ, et une politique ne s'applique pas de
    // la même façon d'un moteur à l'autre : la mesurer sur le seul moteur par défaut publierait une
    // garantie que les deux autres ne tiennent peut-être pas. Ces épreuves n'ont besoin d'aucun
    // artefact v86 et durent quelques secondes ; les trois moteurs de la matrice #2 sont donc
    // TOUJOURS exécutés, indépendamment de `VAULT_MOTEURS`, qui gouverne les relevés du spike #35.
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-csp-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_CSP,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-applications-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_APPLICATIONS,
    })),
  ],
});
