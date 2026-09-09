import { defineConfig } from "@playwright/test";

// Harnais de MESURE des FINS D'ONGLET (#170, tranche 2 de #25, ADR 0032).
//
// Configuration DISTINCTE des suites ordinaires, et le motif n'est pas la commodité : c'est un
// PIÈGE D'OUTIL qui fausserait la mesure sans rien dire.
//
// **Playwright lance Chromium avec `--disable-back-forward-cache`.** Un relevé « aucun document
// n'est jamais restauré depuis le bfcache » pris sous cet argument mesurerait l'ARGUMENT, pas le
// moteur — et il conclurait que le chemin `pageshow` de la coquille ne sert à rien, sur une
// observation que le harnais aurait fabriquée. L'argument est donc RETIRÉ ici, et nulle part
// ailleurs : les suites ordinaires n'ont aucune raison de payer le non-déterminisme d'un cache de
// navigation qu'elles ne mesurent pas.
//
// Ce que Playwright règle sur les DEUX autres moteurs est relevé par la sonde elle-même plutôt que
// supposé : `tests/fins-d-onglet/fins-d-onglet.spec.mjs` publie, pour chaque moteur, les arguments
// et les préférences que le harnais applique, et la matrice de `docs/compatibility.md` les cite.
//
// Les TROIS moteurs sont déclarés. Un moteur qui ne livre pas un événement produit une ligne « non
// livré, par conception » dans son relevé ; il n'est pas retiré de la configuration, parce qu'une
// absence silencieuse ne se distingue pas d'un oubli.

export const FINS_HOST = "127.0.0.1";
/** Coquille. Le port applicatif est le SUIVANT : c'est la règle de `origines-de-la-coquille.mjs`. */
export const FINS_PORT = 4186;
export const FINS_APP_HOST = "localhost";
export const FINS_APP_PORT = FINS_PORT + 1;

export const FINS_ORIGIN = `http://${FINS_HOST}:${FINS_PORT}`;

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

/**
 * Ce que le harnais retire au lanceur de CHAQUE moteur, publié par la sonde avec ses mesures.
 *
 * Seul Chromium reçoit un argument que Playwright pose et que la mesure doit retirer. Firefox et
 * WebKit n'en ont pas d'équivalent connu : leur ligne dit « aucun argument retiré », ce qui est un
 * fait relevé et non un silence.
 */
export const ARGUMENTS_RETIRES = Object.freeze({
  chromium: Object.freeze(["--disable-back-forward-cache"]),
  firefox: Object.freeze([]),
  webkit: Object.freeze([]),
});

/**
 * Le mot-clef qui range une épreuve dans la mesure de BFCACHE, et le projet FENÊTRÉ qui la rejoue.
 *
 * Il est dans le TITRE des épreuves, et non dans un fichier à part : les mêmes épreuves servent aux
 * deux mesures — sans fenêtre sur les trois moteurs, fenêtrée sur Chromium —, et les séparer en
 * ferait deux qui divergeraient.
 */
export const ETIQUETTE_BFCACHE = /@bfcache/;

/**
 * Un moteur ne restaure un document que s'il a une FENÊTRE, et c'est mesuré (#177, constat 2).
 *
 * Sans fenêtre, Chromium ne restaure JAMAIS — pas même une page nue —, et rend `masked` comme raison
 * : un refus de dire, pas une raison. En mode fenêtré, il restaure, y compris sous la politique
 * `no-cache` de la coquille. La conclusion « aucun document n'est jamais restauré » que la première
 * rédaction de #170 publiait décrivait donc le HARNAIS, et le projet ci-dessous existe pour que le
 * dossier cesse de la publier.
 *
 * **Une fenêtre exige un AFFICHAGE.** Sur Windows et macOS il y en a toujours un ; sur Linux il faut
 * `DISPLAY`, que `xvfb-run --auto-servernum` fournit et que `ci.yml` pose. Là où il n'y en a pas, le
 * projet n'est pas déclaré — et il le DIT sur la sortie standard, plutôt que de disparaître en
 * silence : un projet absent sans un mot est indiscernable d'un projet oublié.
 */
const affichageDisponible =
  process.platform === "win32" || process.platform === "darwin" || Boolean(process.env.DISPLAY);

if (!affichageDisponible) {
  process.stdout.write(
    [
      "[fins-d-onglet] projet « chromium-fenetre » NON déclaré : aucun affichage (DISPLAY absent).",
      "[fins-d-onglet] les lignes de bfcache FENÊTRÉES ne sont pas mesurées par cette exécution.",
      "[fins-d-onglet] sur Linux : xvfb-run --auto-servernum npm run test:fins-d-onglet",
      "",
    ].join("\n"),
  );
}

const serveur = (role, host, port) => ({
  command: `node tools/serve.mjs --role ${role} --host ${host} --port ${port}`,
  url: `http://${host}:${port}/`,
  // Jamais de réutilisation : la mesure ne vaut que si les en-têtes sont ceux de CE serveur-ci.
  reuseExistingServer: false,
});

export default defineConfig({
  testDir: "tests/fins-d-onglet",
  outputDir: "test-results/fins-d-onglet",
  fullyParallel: false,
  // Un seul à la fois : deux onglets concurrents se disputeraient le handle exclusif du volume, et
  // la mesure relèverait la contention au lieu du comportement du moteur.
  workers: 1,
  timeout: 300_000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: FINS_ORIGIN,
    trace: "retain-on-failure",
  },
  webServer: [serveur("shell", FINS_HOST, FINS_PORT), serveur("app", FINS_APP_HOST, FINS_APP_PORT)],
  projects: [
    ...moteurs.map((nom) => ({
      name: nom,
      use: {
        browserName: nom,
        // LE PIÈGE, retiré. Voir l'en-tête : sans cela, la mesure du bfcache mesurerait Playwright.
        ...(ARGUMENTS_RETIRES[nom].length > 0
          ? { launchOptions: { ignoreDefaultArgs: [...ARGUMENTS_RETIRES[nom]] } }
          : {}),
      },
    })),
    // Le projet FENÊTRÉ, et lui seul rejoue les épreuves de bfcache : c'est le seul mode où un
    // moteur restaure quoi que ce soit. Même retrait d'argument, même serveurs, même sonde.
    ...(affichageDisponible && moteurs.includes("chromium")
      ? [
          {
            name: "chromium-fenetre",
            grep: ETIQUETTE_BFCACHE,
            use: {
              browserName: "chromium",
              headless: false,
              launchOptions: { ignoreDefaultArgs: [...ARGUMENTS_RETIRES.chromium] },
            },
          },
        ]
      : []),
  ],
});
