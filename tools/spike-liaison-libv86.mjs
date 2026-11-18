#!/usr/bin/env node
// SPIKE — Existe-t-il un mécanisme qui LIE les octets vérifiés de `libv86` aux octets exécutés,
// sous la CSP de la coquille ? (#247, D1g ; revue de sécurité de #298, constat 3 ; ADR 0046.)
//
//     node tools/spike-liaison-libv86.mjs [--json] [--moteurs=chromium,firefox,webkit]
//
// ## La question
//
// `importV86` lit `libv86` par `fetch`, le hache, puis l'importe par `import()` : deux requêtes, et
// rien ne dit que la seconde rend les octets de la première. Un mécanisme LIE si les octets exécutés
// sont, par construction, ceux qui ont été vérifiés — même contre une origine qui répond autrement à
// la seconde requête.
//
// ## Le protocole
//
// Un serveur HTTP local sert la page, un Worker module et un « module » dont le contenu dépend de la
// requête : `Sec-Fetch-Dest: empty` (un `fetch`) reçoit « bon », toute autre destination (un `import()`)
// reçoit « mauvais ». C'est l'origine hostile de la revue — pas une hypothèse de test : ces en-têtes
// sont envoyés par le navigateur. La CSP servie est celle de la coquille (`script-src 'self'`,
// `worker-src 'self'`, `connect-src 'self'`, ni `blob:` ni `unsafe-eval`). Chaque essai est joué
// dans un Worker MODULE, là où `libv86` est importé par le produit.
//
//   E1  `fetch(url, { integrity })` puis `import(url)` : quels octets s'exécutent ? (en-têtes de
//       cache « aucun » puis ceux du produit : `public, max-age=31536000, immutable`)
//   E2  `import(url, { with: { integrity } })` : un moteur sait-il vérifier l'intégrité d'un `import()` ?
//   E3  carte d'import avec `integrity` : dans un Worker (E3a) — le contexte du produit —, puis dans
//       une fenêtre (E3b), pour dire où le mécanisme existe
//   E4  `cache: "only-if-cached"` et `cache: "force-cache"` sur une adresse jamais chargée : le réseau
//       est-il touché ?
//
// Ce que ce spike ne mesure PAS : un Service Worker (interdit par la décision du superviseur), un
// élargissement de la CSP (`blob:`, `unsafe-eval`), ni un moteur autre que les trois de Playwright.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "@playwright/test";

const MODULE_BON = "export const V = 'bon';\n";
const MODULE_MAUVAIS = "export const V = 'mauvais';\n";
const INTEGRITE_DU_BON = `sha256-${createHash("sha256").update(MODULE_BON).digest("base64")}`;
const CSP_DE_LA_COQUILLE =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";

/** Le Worker module : il joue les essais et rend un objet simple. Chaque essai est isolé. */
const WORKER = `
const essai = async (action) => {
  try {
    return { ok: true, ...(await action()) };
  } catch (erreur) {
    return { ok: false, erreur: String(erreur?.name) + ": " + String(erreur?.message).slice(0, 120) };
  }
};
self.onmessage = async ({ data }) => {
  if (data.phase === "amorcer") {
    // E5 : le module est importé UNE fois, comme au premier démarrage en ligne.
    return postMessage(await essai(async () => ({ executeV: (await import("/lib-e5.mjs")).V })));
  }
  if (data.phase === "hors-ligne") {
    // E5 : dans un Worker NEUF, réseau coupé : lecture du cache seule, puis import.
    const sortie = {};
    sortie.lecture = await essai(async () => {
      const reponse = await fetch("/lib-e5.mjs", { cache: "only-if-cached", mode: "same-origin" });
      return { statut: reponse.status, lu: (await reponse.text()).trim() };
    });
    sortie.import = await essai(async () => ({ executeV: (await import("/lib-e5.mjs")).V }));
    return postMessage(sortie);
  }
  const { integrite } = data;
  const sortie = {};
  // E1 : vérifié par fetch + integrity, puis importé.
  for (const [nom, adresse] of [["sansCache", "/lib-e1a.mjs"], ["immutable", "/lib-e1b.mjs"]]) {
    sortie["E1_" + nom] = await essai(async () => {
      const reponse = await fetch(adresse, { integrity: integrite });
      const lu = await reponse.text();
      const module = await import(adresse);
      return { fetchLu: lu.trim(), executeV: module.V };
    });
  }
  // E2 : un attribut d'import « integrity ».
  sortie.E2 = await essai(async () => {
    const module = await import("/lib-e2.mjs", { with: { integrity: integrite } });
    return { executeV: module.V };
  });
  // E3a : un spécificateur nu, que seule une carte d'import résoudrait.
  sortie.E3a = await essai(async () => {
    const module = await import("lib-nu");
    return { executeV: module.V };
  });
  // E4 : le cache, sur des adresses jamais chargées.
  sortie.E4_onlyIfCached = await essai(async () => {
    const reponse = await fetch("/lib-e4a.mjs", { cache: "only-if-cached", mode: "same-origin" });
    return { statut: reponse.status, lu: (await reponse.text()).trim() };
  });
  sortie.E4_forceCache = await essai(async () => {
    const reponse = await fetch("/lib-e4b.mjs", { cache: "force-cache" });
    return { statut: reponse.status, lu: (await reponse.text()).trim() };
  });
  postMessage(sortie);
};
`;

const PAGE_COQUILLE = `<!doctype html><meta charset="utf-8"><title>coquille</title>
<script src="/page.mjs" type="module"></script>`;

const PAGE_MJS = (integrite) => `
const jouer = (message) =>
  new Promise((resolve) => {
    const worker = new Worker("/worker.mjs", { type: "module" });
    worker.onmessage = ({ data }) => { resolve(data); worker.terminate(); };
    worker.postMessage(message);
  });
globalThis.jouer = jouer;
globalThis.__sortie = await jouer({ integrite: "${integrite}" });
`;

/** Une page SANS CSP, avec une carte d'import portant `integrity` : le mécanisme dans une fenêtre. */
const PAGE_FENETRE = (integrite) => `<!doctype html><meta charset="utf-8"><title>fenetre</title>
<script type="importmap">${JSON.stringify({
  imports: { "lib-bon": "/lib-e3-bon.mjs", "lib-mauvais": "/lib-e3-mauvais.mjs" },
  integrity: { "/lib-e3-bon.mjs": integrite, "/lib-e3-mauvais.mjs": integrite },
})}</script>
<script type="module">
  const essai = async (action) => {
    try { return { ok: true, ...(await action()) }; }
    catch (erreur) { return { ok: false, erreur: String(erreur?.name) + ": " + String(erreur?.message).slice(0, 120) }; }
  };
  globalThis.__sortie = {
    E3b_bon: await essai(async () => ({ executeV: (await import("lib-bon")).V })),
    E3b_mauvais: await essai(async () => ({ executeV: (await import("lib-mauvais")).V })),
  };
</script>`;

/** Démarre le serveur d'essai ; rend l'origine, le journal des requêtes et de quoi l'arrêter. */
async function serveur() {
  const journal = [];
  const http = createServer((req, res) => {
    const chemin = new URL(req.url, "http://x").pathname;
    const destination = req.headers["sec-fetch-dest"] ?? "?";
    journal.push({ chemin, destination });
    const ecrire = (statut, type, corps, extra = {}) =>
      res.writeHead(statut, { "content-type": type, ...extra }).end(corps);
    if (chemin === "/") {
      return ecrire(200, "text/html", PAGE_COQUILLE, {
        "content-security-policy": CSP_DE_LA_COQUILLE,
      });
    }
    if (chemin === "/fenetre") return ecrire(200, "text/html", PAGE_FENETRE(INTEGRITE_DU_BON));
    if (chemin === "/page.mjs") {
      return ecrire(200, "text/javascript", PAGE_MJS(INTEGRITE_DU_BON));
    }
    if (chemin === "/worker.mjs") return ecrire(200, "text/javascript", WORKER);
    if (chemin === "/lib-e3-bon.mjs") return ecrire(200, "text/javascript", MODULE_BON);
    if (chemin === "/lib-e3-mauvais.mjs") return ecrire(200, "text/javascript", MODULE_MAUVAIS);
    if (chemin.startsWith("/lib-")) {
      // L'origine hostile : « bon » à un fetch, « mauvais » à tout le reste.
      const corps = destination === "empty" ? MODULE_BON : MODULE_MAUVAIS;
      const immutable = chemin === "/lib-e1b.mjs" || chemin === "/lib-e5.mjs";
      const cache = immutable ? "public, max-age=31536000, immutable" : "no-store";
      return ecrire(200, "text/javascript", corps, { "cache-control": cache });
    }
    return ecrire(404, "text/plain", "");
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    origine: `http://127.0.0.1:${http.address().port}`,
    journal,
    arreter: () => new Promise((resolve) => (http.closeAllConnections(), http.close(resolve))),
  };
}

async function attendre(page) {
  await page.waitForFunction(() => globalThis.__sortie !== undefined, null, { timeout: 30_000 });
  return page.evaluate(() => globalThis.__sortie);
}

/** Joue le protocole sur un moteur. */
async function mesurer(nom, type) {
  const navigateur = await type.launch();
  const serv = await serveur();
  try {
    const contexte = await navigateur.newContext();
    const page = await contexte.newPage();
    await page.goto(`${serv.origine}/`);
    const worker = await attendre(page);
    // E5 : amorcer, puis lire le cache dans un Worker NEUF. Le journal du serveur dit si le réseau
    // a été touché ; couper vraiment le réseau empêcherait aussi de charger le Worker lui-même.
    const amorce = await page.evaluate(() => globalThis.jouer({ phase: "amorcer" }));
    const avant = serv.journal.filter(({ chemin }) => chemin.includes("lib-e5")).length;
    const e5 = await page.evaluate(() => globalThis.jouer({ phase: "hors-ligne" }));
    const apres = serv.journal.filter(({ chemin }) => chemin.includes("lib-e5")).length;
    const fenetre = await contexte.newPage();
    await fenetre.goto(`${serv.origine}/fenetre`);
    const e3b = await attendre(fenetre);
    const requetesDe = (fragment) =>
      serv.journal
        .filter(({ chemin }) => chemin.includes(fragment))
        .map(({ destination }) => destination);
    return {
      moteur: nom,
      version: navigateur.version(),
      ...worker,
      ...e3b,
      E5_amorce: amorce,
      E5: e5,
      E5_requetesDeLaLecture: apres - avant,
      requetes: {
        e1a: requetesDe("lib-e1a"),
        e1b: requetesDe("lib-e1b"),
        e4a: requetesDe("lib-e4a"),
        e4b: requetesDe("lib-e4b"),
        e5: requetesDe("lib-e5"),
      },
    };
  } finally {
    await navigateur.close();
    await serv.arreter();
  }
}

const MOTEURS = { chromium, firefox, webkit };

export async function executer(noms = Object.keys(MOTEURS)) {
  const resultats = [];
  for (const nom of noms) resultats.push(await mesurer(nom, MOTEURS[nom]));
  return resultats;
}

function resumer(r) {
  const ligne = (cle, rendu) => `  ${cle.padEnd(18)} ${rendu}`;
  const e1 = (cle) =>
    r[cle].ok
      ? `fetch a lu « ${r[cle].fetchLu} », l'import a EXÉCUTÉ « ${r[cle].executeV} »`
      : r[cle].erreur;
  const e4 = (cle, requetes) =>
    r[cle].ok
      ? `statut ${r[cle].statut}, requêtes réseau : ${requetes.length} (${requetes.join(",") || "aucune"})`
      : `${r[cle].erreur} ; requêtes réseau : ${requetes.length}`;
  return [
    `## ${r.moteur} ${r.version}`,
    ligne("E1 sans cache", e1("E1_sansCache")),
    ligne("E1 immutable", e1("E1_immutable")),
    ligne("E2 import+integrity", r.E2.ok ? `ACCEPTÉ, a exécuté « ${r.E2.executeV} »` : r.E2.erreur),
    ligne("E3a worker+carte", r.E3a.ok ? `résolu (${r.E3a.executeV})` : r.E3a.erreur),
    ligne("E3b fenêtre bon", r.E3b_bon.ok ? `exécuté « ${r.E3b_bon.executeV} »` : r.E3b_bon.erreur),
    ligne(
      "E3b fenêtre mauvais",
      r.E3b_mauvais.ok
        ? `exécuté « ${r.E3b_mauvais.executeV} » (PAS vérifié)`
        : r.E3b_mauvais.erreur,
    ),
    ligne("E4 only-if-cached", e4("E4_onlyIfCached", r.requetes.e4a)),
    ligne("E4 force-cache", e4("E4_forceCache", r.requetes.e4b)),
    ligne(
      "E5 amorce",
      r.E5_amorce.ok
        ? `importé « ${r.E5_amorce.executeV} » ; requêtes : ${r.requetes.e5.join(",")}`
        : r.E5_amorce.erreur,
    ),
    ligne(
      "E5 hors ligne lecture",
      r.E5.lecture.ok
        ? `statut ${r.E5.lecture.statut}, lu « ${r.E5.lecture.lu} »`
        : r.E5.lecture.erreur,
    ),
    ligne(
      "E5 hors ligne import",
      r.E5.import
        ? r.E5.import.ok
          ? `exécuté « ${r.E5.import.executeV} »`
          : r.E5.import.erreur
        : "(non joué)",
    ),
    ligne(
      "E5 réseau touché",
      `${r.E5_requetesDeLaLecture} requête(s) pendant la lecture et l'import (${r.requetes.e5.join(",")})`,
    ),
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const choix = process.argv.find((argument) => argument.startsWith("--moteurs="));
  const noms = choix ? choix.slice("--moteurs=".length).split(",") : undefined;
  const resultats = await executer(noms);
  if (process.argv.includes("--json"))
    process.stdout.write(`${JSON.stringify(resultats, null, 2)}\n`);
  else process.stdout.write(`${resultats.map(resumer).join("\n\n")}\n`);
}
