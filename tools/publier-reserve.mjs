#!/usr/bin/env node
// Le GÉNÉRATEUR de la RÉSERVE du Service Worker de la coquille (#299, ADR 0048).
//
//   node tools/publier-reserve.mjs --retrait [--prefixes-anciens a-,b-]     écrit le script de retrait
//
// Il est appelé par `tools/publier.mjs` pour l'arbre `coquille`. Ce qu'il produit :
//  - `/sw-coquille.mjs`, le Service Worker : le modèle `tools/reserve/sw-coquille.js` + la liste épinglée ;
//  - `/coquille/reserve-publiee.mjs`, le module que la page et le Worker de confiance importent pour
//    savoir quelle SÉQUENCE de publication ils portent (le dépôt vivant en porte un stub `null`).
//
// ## La liste est CALCULÉE, pas écrite
//
// Liste = l'arbre publié MOINS une table d'exclusions NOMMÉE (`EXCLUS_DE_LA_RESERVE`), MOINS les quatre
// artefacts de VM (passage nommé : le magasin OPFS de #298 les épingle, le Service Worker n'en est que
// le passage de données). « Tout ce qui est publié est dans la liste » ne demande aucun graphe d'imports
// à maintenir : un parcours depuis `index.html` ne voit pas les `import()` calculés (`libv86`, adresses
// du manifeste), il rendrait une réserve partielle par construction.
//
// ## L'identité de cache est le CONTENU
//
// `identite` = SHA-256 de la liste canonique (chemin, taille, SHA-256, type, en-têtes), SANS la séquence,
// le plancher ni l'indicateur de retrait : un plancher relevé sur un contenu inchangé ne réinstalle
// rien, et deux contenus différents ne partagent jamais un nom, même sous la même séquence (§ 5).
//
// ## Les en-têtes viennent de la source de vérité
//
// Le profil d'en-têtes de chaque entrée est ce que `_headers` — rendu depuis `securityHeaders()`, ADR 0017
// § 2 — dit pour ce chemin. Ils ne sont jamais copiés du réseau.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { LONGUEUR_EMPREINTE_DANS_LADRESSE, PREFIXE_ADRESSES_V86 } from "../src/v86-adresses.mjs";
import { PREFIXE_DE_CACHE as PREFIXE, URL_DU_SW } from "../src/coquille/reserve-identite.mjs";
import { analyserHeaders, enTetesPour } from "./publier-en-tetes.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CHEMIN_DU_SW = URL_DU_SW;
export const CHEMIN_DU_MODULE_DE_PAGE = "/coquille/reserve-publiee.mjs";
/** Préfixe de cache RÉSERVÉ au produit : seul ce préfixe est supprimé (et les anciens préfixes NOMMÉS). */
export const PREFIXE_DE_CACHE = PREFIXE;
const MODELE_DU_SW = join(RACINE, "tools", "reserve", "sw-coquille.js");
const MANIFESTE_V86 = join(RACINE, "vendor", "v86", "MANIFEST.json");
const POINT_D_INJECTION = "/*__CONFIG__*/ null";

/** Ce que la publication sert sans que la réserve le liste, avec la raison — une raison par entrée. */
export const EXCLUS_DE_LA_RESERVE = Object.freeze([
  Object.freeze({
    chemin: "/_headers",
    motif:
      "configuration d'hébergement : elle décrit l'hébergeur, elle n'est jamais chargée par la page",
  }),
  Object.freeze({
    chemin: "/inventaire.json",
    motif:
      "inventaire de publication : il décrit l'arbre, il n'est pas du code et n'est pas épinglé par lui-même",
  }),
  Object.freeze({
    chemin: "/artifacts/application.json",
    motif:
      "descripteur de l'application : c'est LA sonde « origine injoignable » de l'ADR 0046 § 3 ; un SW qui le " +
      "servirait la ferait mentir. La réserve de l'application reste le magasin OPFS",
  }),
  Object.freeze({
    chemin: CHEMIN_DU_SW,
    motif:
      "le script du SW lui-même : le navigateur le récupère sans passer par le SW, un SW altéré ne peut " +
      "donc pas empêcher son propre remplacement",
  }),
]);

/**
 * Passage NOMMÉ des artefacts de VM (le magasin OPFS de #298 les épingle), dérivé du manifeste v86 : tout
 * artefact SAUF `libv86`, qui est du code et entre dans la liste. Jamais écrit en dur.
 */
function passageNommeDuManifeste() {
  const manifeste = JSON.parse(readFileSync(MANIFESTE_V86, "utf8"));
  return manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !nom.startsWith("libv86"))
    .map((nom) => {
      const point = nom.lastIndexOf(".");
      const base = nom.slice(0, point).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const extension = nom.slice(point).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `^${PREFIXE_ADRESSES_V86}${base}-[0-9a-f]{${LONGUEUR_EMPREINTE_DANS_LADRESSE}}${extension}$`,
      );
    });
}
export const PASSAGE_NOMME = Object.freeze(passageNommeDuManifeste());

const TYPES = new Map([
  [".ico", "image/vnd.microsoft.icon"],
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);
const typeDe = (chemin) => TYPES.get(chemin.slice(chemin.lastIndexOf("."))) ?? null;
const sha256 = (octets) => createHash("sha256").update(octets).digest("hex");

/** Un chemin que le Service Worker saurait retrouver : c'est son `pathname` exact, et son type est connu. */
function servable(chemin) {
  try {
    return (
      new URL(chemin, "https://coquille.invalide").pathname === chemin && typeDe(chemin) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Classe des chemins publiés. Un chemin qui n'est ni listable, ni exclu, ni en passage est une SURPRISE
 * (`inconnus`) : la publication ne sait pas le servir, et la liste ne le tairait pas.
 *
 * @param {Iterable<string>} chemins
 */
export function classerLesChemins(chemins) {
  const classes = { reserve: [], exclus: [], passage: [], inconnus: [] };
  const exclus = new Set(EXCLUS_DE_LA_RESERVE.map(({ chemin }) => chemin));
  for (const chemin of chemins) {
    if (exclus.has(chemin)) classes.exclus.push(chemin);
    else if (PASSAGE_NOMME.some((motif) => motif.test(chemin))) classes.passage.push(chemin);
    else if (servable(chemin)) classes.reserve.push(chemin);
    else classes.inconnus.push(chemin);
  }
  return classes;
}

function exigerUnEntier(nom, valeur, minimum) {
  if (!Number.isInteger(valeur) || valeur < minimum) {
    throw new Error(
      `${nom} : un entier au moins égal à ${minimum} est attendu, reçu ${String(valeur)}.`,
    );
  }
}
function exigerLesPrefixes(prefixes) {
  for (const prefixe of prefixes) {
    if (
      typeof prefixe !== "string" ||
      !/^[a-z0-9]+(-[a-z0-9]+)*-$/.test(prefixe) ||
      prefixe === PREFIXE_DE_CACHE
    ) {
      throw new Error(
        `préfixe de cache ancien invalide : « ${String(prefixe)} » (minuscules, chiffres, tirets, tiret final).`,
      );
    }
  }
}

/** Le module que la page et le Worker de confiance importent pour connaître leur séquence de publication. */
export function moduleDePage(sequence) {
  return (
    "// Généré par `tools/publier-reserve.mjs` à la publication (#299, ADR 0048) : NE PAS ÉDITER.\n" +
    "// Le dépôt vivant porte un stub `null` : sans ce module, la coquille n'enregistre aucun Service Worker.\n" +
    `export const RESERVE_PUBLIEE = Object.freeze({ sequence: ${sequence} });\n`
  );
}

function injecter(config) {
  const modele = readFileSync(MODELE_DU_SW, "utf8");
  if (!modele.includes(POINT_D_INJECTION))
    throw new Error("le modèle du SW n'a pas de point d'injection");
  // Fonction de remplacement : un `$` du JSON (une expression régulière de passage) n'est pas un motif.
  return modele.replace(POINT_D_INJECTION, () => JSON.stringify(config));
}

/**
 * @param {object} o
 * @param {Map<string, Uint8Array>} o.fichiers l'arbre publié : chemin (avec `/`) → octets
 * @param {(chemin: string) => Record<string, string>} o.entetesDe les en-têtes servis pour ce chemin
 * @param {number} o.sequence numéro de publication (monotone)
 * @param {number} [o.plancher] séquence minimale : toute version plus ancienne est révoquée
 * @param {string[]} [o.prefixesAnciens] anciens préfixes de cache à supprimer par nom (migration, § 11)
 */
export function fabriquerLaReserve({
  fichiers,
  entetesDe,
  sequence,
  plancher = 0,
  prefixesAnciens = [],
}) {
  exigerUnEntier("séquence", sequence, 1);
  exigerUnEntier("plancher", plancher, 0);
  exigerLesPrefixes(prefixesAnciens);
  const classes = classerLesChemins(fichiers.keys());
  if (classes.inconnus.length > 0) {
    throw new Error(
      `fichiers publiés que la réserve ne saurait servir : ${classes.inconnus.join(", ")}.`,
    );
  }
  const profils = [];
  const indexDesProfils = new Map();
  const liste = {};
  const lignes = [];
  for (const chemin of [...classes.reserve].sort((a, b) => (a < b ? -1 : 1))) {
    const octets = fichiers.get(chemin);
    const entetes = entetesDe(chemin);
    const cle = JSON.stringify(Object.entries(entetes).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (!indexDesProfils.has(cle)) {
      indexDesProfils.set(cle, profils.length);
      profils.push(entetes);
    }
    liste[chemin] = {
      taille: octets.byteLength,
      sha256: sha256(octets),
      type: typeDe(chemin),
      profil: indexDesProfils.get(cle),
    };
    lignes.push([chemin, liste[chemin].taille, liste[chemin].sha256, liste[chemin].type, cle]);
  }
  // `/` sert la page d'index : alias, mêmes octets, mêmes en-têtes.
  const alias = liste["/index.html"] === undefined ? {} : { "/": "/index.html" };
  const identite = sha256(JSON.stringify(lignes));
  const config = {
    identite,
    sequence,
    plancher,
    retrait: false,
    liste,
    alias,
    profils,
    passage: PASSAGE_NOMME.map((motif) => motif.source),
    prefixesAnciens,
  };
  return {
    liste,
    alias,
    profils,
    identite,
    config,
    script: injecter(config),
    moduleDePage: moduleDePage(sequence),
    classes,
  };
}

/** Le SCRIPT DE RETRAIT (kill-switch, § 11) : même modèle, sans liste, publié À LA MÊME URL. */
export function fabriquerLeScriptDeRetrait({ prefixesAnciens = [] } = {}) {
  exigerLesPrefixes(prefixesAnciens);
  return injecter({
    identite: "retrait",
    sequence: 0,
    plancher: 0,
    retrait: true,
    liste: {},
    alias: {},
    profils: [],
    passage: [],
    prefixesAnciens,
  });
}

function lister(dossier) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const complet = join(dossier, nom);
    if (statSync(complet).isDirectory()) sortie.push(...lister(complet));
    else sortie.push(complet);
  }
  return sortie;
}

/**
 * Produit la réserve d'un arbre `coquille` DÉJÀ construit (sources copiées et `_headers` écrit) : écrit
 * `/sw-coquille.mjs` à sa racine et le module de page généré. Appelé par `tools/publier.mjs`.
 *
 * @param {{ destination: string, sequence: number, plancher?: number, prefixesAnciens?: string[] }} o
 */
export async function produireLaReserve({
  destination,
  sequence,
  plancher = 0,
  prefixesAnciens = [],
}) {
  const fichiers = new Map();
  for (const complet of lister(destination)) {
    fichiers.set("/" + relative(destination, complet).split(sep).join("/"), readFileSync(complet));
  }
  // Le module de page fait partie de la liste, tel qu'il sera publié : il est généré AVANT de la calculer.
  fichiers.set(CHEMIN_DU_MODULE_DE_PAGE, Buffer.from(moduleDePage(sequence)));
  const regles = analyserHeaders(await readFile(join(destination, "_headers"), "utf8"));
  const reserve = fabriquerLaReserve({
    fichiers,
    entetesDe: (chemin) => enTetesPour(regles, chemin),
    sequence,
    plancher,
    prefixesAnciens,
  });
  await mkdir(join(destination, "coquille"), { recursive: true });
  await writeFile(
    join(destination, "coquille", "reserve-publiee.mjs"),
    reserve.moduleDePage,
    "utf8",
  );
  await writeFile(join(destination, CHEMIN_DU_SW.slice(1)), reserve.script, "utf8");
  return {
    identite: reserve.identite,
    entrees: Object.keys(reserve.liste).length,
    taille: Object.values(reserve.liste).reduce((somme, entree) => somme + entree.taille, 0),
    sequence,
    plancher,
  };
}

function lireOption(argv, nom) {
  const index = argv.indexOf(`--${nom}`);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (!argv.includes("--retrait")) {
    process.stderr.write(
      "usage : node tools/publier-reserve.mjs --retrait [--prefixes-anciens a-,b-]\n",
    );
    process.exitCode = 3;
  } else {
    const anciens = lireOption(argv, "prefixes-anciens");
    process.stdout.write(
      fabriquerLeScriptDeRetrait({
        prefixesAnciens: anciens === null || anciens === "" ? [] : anciens.split(","),
      }),
    );
  }
}
