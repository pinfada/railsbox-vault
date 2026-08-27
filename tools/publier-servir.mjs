#!/usr/bin/env node
// Sert une arborescence publiée EN APPLIQUANT le fichier `_headers` qu'elle porte.
//
//   node tools/publier-servir.mjs --arbre artifacts/publication/coquille --port 4193
//
// Pourquoi ce serveur existe alors que `tools/serve.mjs` sert déjà le dépôt : ce n'est pas le même
// objet qui est mesuré. `tools/serve.mjs` sert le DÉPÔT sous des en-têtes calculés à la volée ;
// celui-ci sert l'ARTEFACT PUBLIÉ sous les en-têtes que l'artefact déclare. C'est la seule manière
// de vérifier que le `_headers` produit dit bien ce que l'hébergeur devra servir — un fichier de
// configuration qu'on n'a jamais fait exécuter par personne n'est qu'une intention.
//
// Il ne remplace ni ne modifie `tools/serve-headers.mjs`, qui reste la source de vérité : le
// `_headers` en est dérivé, et ce serveur ne fait que le relire.
//
// `--retirer <en-tête>` retire un en-tête de ce qui est servi. C'est l'instrument du TÉMOIN
// NÉGATIF : sans une condition où `Cross-Origin-Opener-Policy` est absent et où `window.opener`
// SURVIT, un relevé « opener === null » ne prouverait pas que COOP y est pour quelque chose.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { FICHIER_HEADERS } from "./publier-en-tetes.mjs";

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".bin", "application/octet-stream"],
  [".iso", "application/octet-stream"],
]);

/**
 * Analyse le format `_headers` de Cloudflare Pages et de Netlify : une ligne de motif commençant
 * par `/`, puis des lignes indentées `Nom: valeur`. Les lignes vides et les `#` sont des
 * commentaires.
 *
 * @param {string} texte
 * @returns {{ motif: string, enTetes: [string, string][] }[]}
 */
export function analyserHeaders(texte) {
  const regles = [];
  for (const ligne of texte.split("\n")) {
    const nue = ligne.trim();
    if (nue === "" || nue.startsWith("#")) continue;
    if (!ligne.startsWith(" ") && !ligne.startsWith("\t")) {
      regles.push({ motif: nue, enTetes: [] });
      continue;
    }
    const separateur = nue.indexOf(":");
    if (separateur < 0 || regles.length === 0) continue;
    regles.at(-1).enTetes.push([nue.slice(0, separateur).trim(), nue.slice(separateur + 1).trim()]);
  }
  return regles;
}

/**
 * @param {{ motif: string, enTetes: [string, string][] }[]} regles
 * @param {string} chemin
 * @param {readonly string[]} retires
 */
export function enTetesPour(regles, chemin, retires = []) {
  const exclus = new Set(retires.map((nom) => nom.toLowerCase()));
  const resultat = {};
  for (const { motif, enTetes } of regles) {
    const correspond = motif.endsWith("/*")
      ? chemin.startsWith(motif.slice(0, -1))
      : motif === chemin;
    if (!correspond) continue;
    for (const [nom, valeur] of enTetes) {
      if (!exclus.has(nom.toLowerCase())) resultat[nom] = valeur;
    }
  }
  return resultat;
}

function lireOption(argv, nom, defaut = null) {
  const index = argv.indexOf(`--${nom}`);
  if (index < 0) return defaut;
  const valeur = argv[index + 1];
  if (valeur === undefined || valeur.startsWith("--")) {
    throw new Error(`L'option --${nom} attend une valeur.`);
  }
  return valeur;
}

function lireRepetable(argv, nom) {
  const valeurs = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${nom}` && argv[index + 1] !== undefined) valeurs.push(argv[index + 1]);
  }
  return valeurs;
}

/**
 * @param {{ arbre: string, host: string, port: number, retires: readonly string[] }} options
 */
export async function demarrer(options) {
  const racine = resolve(options.arbre);
  const regles = analyserHeaders(await readFile(resolve(racine, FICHIER_HEADERS), "utf8"));

  const serveur = createServer(async (requete, reponse) => {
    const url = new URL(requete.url ?? "/", "http://localhost");
    const chemin = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    const candidat = resolve(racine, chemin.slice(1));
    if (candidat !== racine && !candidat.startsWith(`${racine}${sep}`)) {
      reponse.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const metadonnees = await stat(candidat);
      if (!metadonnees.isFile()) throw new Error("Not a file");
      reponse.writeHead(200, {
        "Content-Type": TYPES.get(extname(candidat)) ?? "application/octet-stream",
        ...enTetesPour(regles, chemin, options.retires),
      });
      createReadStream(candidat).pipe(reponse);
    } catch {
      reponse.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });

  await new Promise((tenu) => serveur.listen(options.port, options.host, tenu));
  return {
    origine: `http://${options.host}:${options.port}`,
    arreter: () => new Promise((tenu) => serveur.close(tenu)),
  };
}

if (process.argv[1]?.endsWith("publier-servir.mjs")) {
  const argv = process.argv.slice(2);
  const { origine } = await demarrer({
    arbre: lireOption(argv, "arbre", "artifacts/publication/coquille"),
    host: lireOption(argv, "host", "127.0.0.1"),
    port: Number(lireOption(argv, "port", "4193")),
    retires: lireRepetable(argv, "retirer"),
  });
  process.stdout.write(`Arbre publié servi sur ${origine}\n`);
}
