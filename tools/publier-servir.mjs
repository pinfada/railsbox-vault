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

import { FICHIER_HEADERS, analyserHeaders, enTetesPour } from "./publier-en-tetes.mjs";
import { enTetesDAbsence } from "./serve-headers.mjs";

// L'analyseur du format `_headers` et l'application de ses règles vivent désormais dans le module
// qui ÉCRIT le fichier (#103, ADR 0023) : depuis que la politique de cache varie par nature
// d'artefact, la publication doit vérifier elle-même l'aller-retour — que le fichier produit rende
// à chaque chemin ce que la source de vérité y sert — et elle ne peut pas le faire en important le
// serveur, qui l'importe déjà. Ils sont réexportés ici pour leurs appelants historiques, et ce
// serveur en reste l'unique consommateur en production.
export { analyserHeaders, enTetesPour };

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
      // Le `_headers` de l'arbre annonce sa politique pour un CHEMIN ; ce serveur sert une
      // RÉPONSE, et une absence n'est jamais cachable (constat 1 de la revue de #123). Sans cela,
      // un 404 sous `/vendor/v86/artefacts/*` partirait avec un an d'`immutable`.
      reponse
        .writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          ...enTetesDAbsence(),
        })
        .end("Not found");
    }
  });

  // Un port déjà pris est le mode de panne le plus banal du témoin — un run précédent interrompu,
  // deux suites lancées en parallèle — et le laisser remonter en trace de `net:` ferait chercher un
  // défaut de publication là où il n'y a qu'un socket. Le diagnostic est donc nommé.
  await new Promise((tenu, echoue) => {
    serveur.once("error", (erreur) => {
      echoue(
        erreur.code === "EADDRINUSE"
          ? new Error(
              `Le port ${options.port} (${options.host}) est déjà pris : un serveur du témoin ` +
                "tourne encore. Arrêtez-le, ou attendez la fin du run précédent.",
            )
          : erreur,
      );
    });
    serveur.listen(options.port, options.host, tenu);
  });
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
