#!/usr/bin/env node
// SONDE : que peut, et que ne peut pas, une CSP posée par `<meta http-equiv>` ?
//
//   node tools/publier-sonde-meta-csp.mjs
//   VAULT_MOTEURS=chromium,firefox,webkit node tools/publier-sonde-meta-csp.mjs
//
// La question est celle de #45, et elle décide d'un hébergeur. GitHub Pages ne sert aucun en-tête
// de réponse personnalisé (ADR 0010, fait mesuré à nouveau par `tools/publier-sonde-hebergement.mjs`).
// Si un `<meta http-equiv="Content-Security-Policy">` suffisait à porter la politique de l'ADR 0013,
// Pages resterait en course sans contorsion. Il faut donc mesurer, et non citer : quelles
// directives un `<meta>` applique-t-il réellement, et lesquelles le navigateur ignore-t-il ?
//
// Cinq relevés, chacun avec le témoin qui le rend lisible :
//
//  1. `frame-ancestors` dans un `<meta>` — appliqué, ou ignoré ? Témoin : la MÊME directive servie
//     en en-tête de réponse, sur la même page, par le même serveur.
//  2. COOP dans un `<meta http-equiv>` — `window.opener` survit-il ? Témoin : le relevé d'en-tête
//     de `tools/publier-temoin.mjs`, où il ne survit pas.
//  3. `script-src 'self'` dans un `<meta>` — un script en ligne est-il refusé ?
//  4. Un script placé AVANT le `<meta>` s'exécute-t-il quand même ?
//  5. `sandbox` dans un `<meta>` — l'origine du document devient-elle opaque ?
//
// Les relevés 3 à 5 sont de même origine : Playwright lit le document directement. Les relevés 1
// et 2 exigent deux origines réelles, obtenues comme partout dans ce dépôt par `127.0.0.1` et
// `localhost`, qui sont deux origines distinctes sans DNS ni certificat.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, firefox, webkit } from "@playwright/test";

import { demarrer } from "./publier-servir.mjs";
import { REPOSITORY_ROOT } from "./v86-paths.mjs";

const MOTEURS = { chromium, firefox, webkit };

const PORT_SONDE = 4196;
const PORT_TIERS = 4197;
const ORIGINE_SONDE = `http://127.0.0.1:${PORT_SONDE}`;
const ORIGINE_TIERS = `http://localhost:${PORT_TIERS}`;

const RACINE = join(REPOSITORY_ROOT, "artifacts", "publication-sonde-meta");
const RAPPORT = join(REPOSITORY_ROOT, "reports", "publication", "sonde-meta-csp.json");

/** Délai au-delà duquel l'absence d'annonce d'un cadre est tenue pour un refus. */
const DELAI_CADRE_MS = 3000;

const ANNONCE = `<script>parent.postMessage("cadre-charge", "*");</script>`;

const FICHIERS = Object.freeze({
  // 1 — la directive par `<meta>`.
  "meta-frame-ancestors.html": `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'" />
<title>meta frame-ancestors</title></head><body>${ANNONCE}</body></html>`,
  // 1 (témoin) — la MÊME directive, servie en en-tête par `_headers`.
  "entete-frame-ancestors.html": `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<title>en-tête frame-ancestors</title></head><body>${ANNONCE}</body></html>`,
  // 2 — COOP par `<meta http-equiv>`.
  "meta-coop.html": `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<meta http-equiv="Cross-Origin-Opener-Policy" content="same-origin" />
<title>meta COOP</title></head><body><p>ouverte</p></body></html>`,
  // 3 — `script-src 'self'` par `<meta>` : le script en ligne doit être refusé, le script externe
  //     de la même origine doit passer. Deux marques distinctes, pour ne pas confondre « refusé »
  //     et « la page n'a rien exécuté du tout ».
  "meta-script-src.html": `<!doctype html><html lang="fr" data-en-ligne="non" data-externe="non"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'" />
<title>meta script-src</title></head><body>
<script>document.documentElement.dataset.enLigne = "oui";</script>
<script src="./marque-externe.js"></script>
</body></html>`,
  "marque-externe.js": `document.documentElement.dataset.externe = "oui";\n`,
  // 4 — ordre d'analyse : un script AVANT le `<meta>`.
  "meta-apres-script.html": `<!doctype html><html lang="fr" data-avant="non" data-apres="non"><head><meta charset="utf-8" />
<script>document.documentElement.dataset.avant = "oui";</script>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'" />
</head><body>
<script>document.documentElement.dataset.apres = "oui";</script>
</body></html>`,
  // 5 — `sandbox` par `<meta>`.
  "meta-sandbox.html": `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="sandbox allow-scripts" />
<title>meta sandbox</title></head><body><p>sandbox</p></body></html>`,
});

const EMBARQUEUR = `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<title>embarqueur</title></head><body><div id="cible"></div></body></html>`;

const HEADERS_SONDE = `/*
  X-Content-Type-Options: nosniff
/entete-frame-ancestors.html
  Content-Security-Policy: frame-ancestors 'none'
`;

const HEADERS_TIERS = `/*
  X-Content-Type-Options: nosniff
`;

async function ecrireFixtures() {
  await rm(RACINE, { recursive: true, force: true });
  await mkdir(join(RACINE, "sonde"), { recursive: true });
  await mkdir(join(RACINE, "tiers"), { recursive: true });
  for (const [nom, contenu] of Object.entries(FICHIERS)) {
    await writeFile(join(RACINE, "sonde", nom), contenu, "utf8");
  }
  await writeFile(join(RACINE, "sonde", "_headers"), HEADERS_SONDE, "utf8");
  await writeFile(join(RACINE, "tiers", "index.html"), EMBARQUEUR, "utf8");
  await writeFile(join(RACINE, "tiers", "_headers"), HEADERS_TIERS, "utf8");
}

/** Le cadre s'est-il chargé ? Mesuré par une ANNONCE du document encadré, jamais par un message
 *  de console : l'ADR 0010 a relevé que trois moteurs rendent trois signatures différentes d'un
 *  refus, et que Firefox n'en rend aucune. L'absence d'annonce, elle, se lit partout. */
async function cadreSeCharge(contexte, url) {
  const page = await contexte.newPage();
  await page.goto(`${ORIGINE_TIERS}/index.html`, { waitUntil: "load" });
  const charge = await page.evaluate(
    async ({ url, delai }) => {
      const attente = new Promise((tenu) => {
        globalThis.addEventListener("message", (event) => {
          if (event.data === "cadre-charge") tenu(true);
        });
        setTimeout(() => tenu(false), delai);
      });
      const cadre = globalThis.document.createElement("iframe");
      cadre.src = url;
      globalThis.document.querySelector("#cible").append(cadre);
      return attente;
    },
    { url, delai: DELAI_CADRE_MS },
  );
  await page.close();
  return charge;
}

async function openerSurvit(contexte, url) {
  const ouvreur = await contexte.newPage();
  await ouvreur.goto(`${ORIGINE_TIERS}/index.html`, { waitUntil: "load" });
  const [popup] = await Promise.all([
    contexte.waitForEvent("page"),
    ouvreur.evaluate((cible) => globalThis.open(cible, "_blank"), url),
  ]);
  await popup.waitForLoadState("load");
  const survit = await popup.evaluate(() => globalThis.opener !== null);
  await popup.close();
  await ouvreur.close();
  return survit;
}

async function marques(contexte, chemin, noms) {
  const page = await contexte.newPage();
  await page.goto(`${ORIGINE_SONDE}/${chemin}`, { waitUntil: "load" });
  const releve = await page.evaluate(
    (noms) =>
      Object.fromEntries(
        noms.map((nom) => [nom, globalThis.document.documentElement.dataset[nom]]),
      ),
    noms,
  );
  await page.close();
  return releve;
}

async function origineOpaque(contexte, chemin) {
  const page = await contexte.newPage();
  await page.goto(`${ORIGINE_SONDE}/${chemin}`, { waitUntil: "load" });
  const releve = await page.evaluate(() => {
    try {
      return {
        origine: globalThis.location.origin,
        stockage: globalThis.localStorage === null ? "null" : "accessible",
      };
    } catch (erreur) {
      return { origine: globalThis.location.origin, stockage: `refusé : ${erreur.name}` };
    }
  });
  await page.close();
  return releve;
}

async function mesurerMoteur(nom) {
  const navigateur = await MOTEURS[nom].launch();
  const contexte = await navigateur.newContext();
  const mesure = {
    moteur: nom,
    frameAncestorsParMeta: await cadreSeCharge(
      contexte,
      `${ORIGINE_SONDE}/meta-frame-ancestors.html`,
    ),
    frameAncestorsParEnTete: await cadreSeCharge(
      contexte,
      `${ORIGINE_SONDE}/entete-frame-ancestors.html`,
    ),
    openerAvecMetaCoop: await openerSurvit(contexte, `${ORIGINE_SONDE}/meta-coop.html`),
    scriptSrcParMeta: await marques(contexte, "meta-script-src.html", ["enLigne", "externe"]),
    ordreDAnalyse: await marques(contexte, "meta-apres-script.html", ["avant", "apres"]),
    sandboxParMeta: await origineOpaque(contexte, "meta-sandbox.html"),
  };
  await navigateur.close();
  return mesure;
}

function decrire(mesure) {
  return [
    `[${mesure.moteur}]`,
    `  frame-ancestors par <meta>       cadre ${mesure.frameAncestorsParMeta ? "CHARGÉ (directive ignorée)" : "refusé"}`,
    `  frame-ancestors par en-tête      cadre ${mesure.frameAncestorsParEnTete ? "CHARGÉ" : "refusé (attendu)"}`,
    `  window.opener avec <meta> COOP   ${mesure.openerAvecMetaCoop ? "SURVIT (COOP inexprimable)" : "null"}`,
    `  script en ligne sous <meta>      ${mesure.scriptSrcParMeta.enLigne === "oui" ? "EXÉCUTÉ" : "refusé (attendu)"}`,
    `  script externe sous <meta>       ${mesure.scriptSrcParMeta.externe === "oui" ? "exécuté (attendu)" : "REFUSÉ"}`,
    `  script AVANT le <meta>           ${mesure.ordreDAnalyse.avant === "oui" ? "EXÉCUTÉ (le <meta> ne le couvre pas)" : "refusé"}`,
    `  script APRÈS le <meta>           ${mesure.ordreDAnalyse.apres === "oui" ? "EXÉCUTÉ" : "refusé (attendu)"}`,
    `  sandbox par <meta>               origine ${mesure.sandboxParMeta.origine}, stockage ${mesure.sandboxParMeta.stockage}`,
  ].join("\n");
}

async function principal() {
  const moteurs = (process.env.VAULT_MOTEURS ?? "chromium")
    .split(",")
    .map((nom) => nom.trim())
    .filter(Boolean);
  await ecrireFixtures();
  const serveurs = await Promise.all([
    demarrer({ arbre: join(RACINE, "sonde"), host: "127.0.0.1", port: PORT_SONDE, retires: [] }),
    demarrer({ arbre: join(RACINE, "tiers"), host: "localhost", port: PORT_TIERS, retires: [] }),
  ]);
  const mesures = [];
  try {
    for (const moteur of moteurs) mesures.push(await mesurerMoteur(moteur));
  } finally {
    await Promise.all(serveurs.map(({ arreter }) => arreter()));
  }
  for (const mesure of mesures) process.stdout.write(`${decrire(mesure)}\n`);
  await mkdir(join(RAPPORT, ".."), { recursive: true });
  await writeFile(RAPPORT, `${JSON.stringify({ mesures }, null, 2)}\n`, "utf8");
  process.stdout.write(`\nRapport : ${RAPPORT}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("publier-sonde-meta-csp.mjs")) {
  process.exitCode = await principal();
}
