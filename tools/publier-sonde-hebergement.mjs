#!/usr/bin/env node
// SONDE D'HÉBERGEMENT : quels en-têtes de sécurité un hébergeur statique sert-il réellement, et
// quels suffixes publics l'empêchent de fournir DEUX SITES distincts ?
//
//   node tools/publier-sonde-hebergement.mjs           interroge le réseau
//   node tools/publier-sonde-hebergement.mjs --hors-ligne   rejoue le dernier relevé
//
// Deux relevés, tous deux issus du réseau et non d'une lecture de documentation :
//
//  1. EN-TÊTES SERVIS — une requête `GET` sur un site témoin de chaque hébergeur, et la liste des
//     en-têtes de sécurité présents dans la réponse. Ce commentaire a longtemps annoncé `HEAD` là
//     où le code émettait `GET` : #106 a tranché le désaccord en faveur de `GET`, dont le motif est
//     écrit à `METHODE_SONDE`. Ce que le relevé établit est étroit et il faut le
//     dire : qu'un site témoin ne serve pas COOP prouve que son propriétaire ne l'a pas configuré,
//     pas que l'hébergeur en soit incapable. La conclusion pour GitHub Pages ne repose donc PAS sur
//     ce relevé seul, mais sur le fait que Pages ne propose aucun mécanisme de configuration
//     d'en-têtes — pas de `_headers`, pas de `vercel.json`, pas de règle de proxy — et la sonde le
//     rend visible en montrant qu'un `_headers` déposé à la racine d'un site Pages est servi comme
//     un fichier ordinaire au lieu d'être interprété.
//
//  2. SUFFIXES PUBLICS — la Public Suffix List est téléchargée et les suffixes des hébergeurs y
//     sont cherchés. C'est le fait qui décide de la question « deux origines, mais combien de SITES
//     ? » : `a.pages.dev` et `b.pages.dev` sont deux SITES si `pages.dev` est un suffixe public,
//     et deux sous-domaines d'un même site s'il ne l'est pas. Les conséquences — partitionnement,
//     `SameSite`, cookies — sont écrites dans le spike, pas ici.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { REPOSITORY_ROOT } from "./v86-paths.mjs";

const RAPPORT = join(REPOSITORY_ROOT, "reports", "publication", "sonde-hebergement.json");

/** En-têtes dont la présence ou l'absence décide de l'hébergement (ADR 0013, ADR 0010, ADR 0017). */
export const EN_TETES_SUIVIS = Object.freeze([
  "content-security-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "x-content-type-options",
  "strict-transport-security",
  "cache-control",
  "server",
]);

/**
 * Sites témoins. Ils sont choisis parce qu'ils sont notoirement servis par l'hébergeur nommé, et
 * qu'ils ne nous appartiennent pas : la sonde mesure ce que le PUBLIC reçoit.
 */
export const TEMOINS = Object.freeze([
  Object.freeze({
    hebergeur: "GitHub Pages",
    url: "https://squidfunk.github.io/mkdocs-material/",
    mecanismeDEnTetes: "aucun",
  }),
  Object.freeze({
    hebergeur: "GitHub Pages (404 du service)",
    url: "https://pinfada.github.io/inexistant-sonde-45/",
    mecanismeDEnTetes: "aucun",
  }),
  Object.freeze({
    hebergeur: "Netlify",
    url: "https://docs.netlify.com/",
    mecanismeDEnTetes: "_headers, netlify.toml",
  }),
  Object.freeze({
    hebergeur: "Cloudflare Pages",
    url: "https://developers.cloudflare.com/pages/configuration/headers/",
    mecanismeDEnTetes: "_headers",
  }),
  Object.freeze({
    hebergeur: "Vercel",
    url: "https://vercel.com/docs/headers",
    mecanismeDEnTetes: "vercel.json (headers)",
  }),
]);

/** Suffixes cherchés dans la Public Suffix List. */
export const SUFFIXES = Object.freeze([
  "github.io",
  "pages.dev",
  "netlify.app",
  "vercel.app",
  "web.app",
  "firebaseapp.com",
]);

export const URL_PSL = "https://publicsuffix.org/list/public_suffix_list.dat";

/**
 * Un suffixe est-il inscrit à la PSL ? La liste porte aussi des règles de caractère générique
 * (`*.foo`) et des exceptions (`!bar.foo`) : la recherche vise la ligne EXACTE, seule forme qui
 * fasse du suffixe un site à part entière.
 *
 * @param {string} liste contenu brut de la PSL
 * @param {string} suffixe
 */
export function suffixeInscrit(liste, suffixe) {
  return liste.split("\n").some((ligne) => ligne.trim() === suffixe);
}

/**
 * La sonde interroge en **GET**, et c'est une décision tenue, pas un reste (#106, L4).
 *
 * La revue de sécurité de #45 a relevé qu'un `HEAD` suffirait à lire des en-têtes. Le motif de
 * garder `GET` est écrit ici pour qu'une bascule future ait à le contredire explicitement, et
 * `tests/unit/publication-robustesse.test.mjs` mesure la méthode réellement émise.
 */
export const METHODE_SONDE = Object.freeze({
  methode: "GET",
  motif:
    "La sonde mesure ce que le PUBLIC reçoit, et le public reçoit un GET. Plusieurs hébergeurs et " +
    "CDN ne traitent pas HEAD comme GET : certains répondent 405, d'autres omettent les en-têtes " +
    "qu'une couche applicative ajoute au corps servi. Une réponse HEAD dégradée serait enregistrée " +
    "ici comme « en-tête absent » — un FAUX NÉGATIF sur un en-tête de sécurité, c'est-à-dire " +
    "l'erreur coûteuse dans le sens qui compte pour cette sonde, puisque ses conclusions " +
    "d'hébergement en dépendent. Le prix payé est cinq documents téléchargés une fois, à la main, " +
    "à côté d'une Public Suffix List qui pèse déjà davantage et qu'aucun HEAD ne remplacerait.",
});

/**
 * Interroge un site témoin et relève ses en-têtes suivis.
 *
 * @param {{ hebergeur: string, url: string, mecanismeDEnTetes: string }} temoin
 * @param {typeof fetch} [requete] injectable : l'épreuve mesure la méthode réellement émise
 */
export async function interroger(temoin, requete = fetch) {
  try {
    const reponse = await requete(temoin.url, {
      method: METHODE_SONDE.methode,
      redirect: "follow",
    });
    const enTetes = {};
    for (const nom of EN_TETES_SUIVIS) enTetes[nom] = reponse.headers.get(nom);
    return { ...temoin, statut: reponse.status, urlFinale: reponse.url, enTetes };
  } catch (erreur) {
    return { ...temoin, statut: null, urlFinale: null, enTetes: null, erreur: erreur.message };
  }
}

async function relever() {
  const hebergeurs = [];
  for (const temoin of TEMOINS) hebergeurs.push(await interroger(temoin));
  const liste = await (await fetch(URL_PSL)).text();
  const suffixes = SUFFIXES.map((suffixe) => ({
    suffixe,
    inscritALaPsl: suffixeInscrit(liste, suffixe),
  }));
  return { mesureLe: new Date().toISOString(), hebergeurs, suffixes, sourcePsl: URL_PSL };
}

function decrire(releve) {
  const lignes = [`Relevé du ${releve.mesureLe}`, "", "EN-TÊTES SERVIS"];
  for (const hebergeur of releve.hebergeurs) {
    lignes.push(`  ${hebergeur.hebergeur} — ${hebergeur.url}`);
    lignes.push(`    statut ${hebergeur.statut ?? `ERREUR : ${hebergeur.erreur}`}`);
    lignes.push(`    mécanisme d'en-têtes déclaré : ${hebergeur.mecanismeDEnTetes}`);
    for (const [nom, valeur] of Object.entries(hebergeur.enTetes ?? {})) {
      lignes.push(`    ${nom.padEnd(30)} ${valeur ?? "(absent)"}`);
    }
  }
  lignes.push("", "SUFFIXES PUBLICS");
  for (const { suffixe, inscritALaPsl } of releve.suffixes) {
    lignes.push(
      `  ${suffixe.padEnd(20)} ${inscritALaPsl ? "INSCRIT — deux sous-domaines y sont deux SITES" : "absent"}`,
    );
  }
  return lignes.join("\n");
}

async function principal(argv) {
  const releve = argv.includes("--hors-ligne")
    ? JSON.parse(await readFile(RAPPORT, "utf8"))
    : await relever();
  process.stdout.write(`${decrire(releve)}\n`);
  if (!argv.includes("--hors-ligne")) {
    await mkdir(join(RAPPORT, ".."), { recursive: true });
    await writeFile(RAPPORT, `${JSON.stringify(releve, null, 2)}\n`, "utf8");
    process.stdout.write(`\nRapport : ${RAPPORT}\n`);
  }
  return 0;
}

if (process.argv[1]?.endsWith("publier-sonde-hebergement.mjs")) {
  process.exitCode = await principal(process.argv.slice(2));
}
