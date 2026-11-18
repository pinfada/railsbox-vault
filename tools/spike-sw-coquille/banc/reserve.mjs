// Générateur de la RÉSERVE du spike D1h : liste épinglée + script du Service Worker.
//
// Entrée : l'arbre PUBLIÉ de la coquille (`tools/publier.mjs`, jamais le dépôt vivant) plus les
// fixtures du spike (`pages/`) et des surcharges de génération (octets d'un fichier, séquence,
// plancher, variante de mutant, fautes injectées). Sortie : une `Generation` = ce que l'origine
// sert à un instant donné (fichiers + script du SW). Une « publication v2 » est une autre génération.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { analyserHeaders, enTetesPour } from "../../publier-en-tetes.mjs";

export const RACINE_DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CHEMIN_DU_SW = "/sw-coquille.mjs";
export const ARBRE_PUBLIE = join(RACINE_DEPOT, "artifacts", "publication-spike", "coquille");
const PAGES = join(RACINE_DEPOT, "tools", "spike-sw-coquille", "pages");
const BANC = join(RACINE_DEPOT, "tools", "spike-sw-coquille", "banc");

/** Fichiers publiés qui NE SONT PAS dans la réserve, avec la raison (liste nommée, DoR § 1). */
export const EXCLUS_DE_LA_RESERVE = Object.freeze([
  { chemin: "/_headers", motif: "configuration d'hébergement, jamais chargée par la page" },
  { chemin: "/inventaire.json", motif: "inventaire de publication, hors de l'arbre épinglé" },
]);
/** Passage NOMMÉ au réseau, en plus de `/artifacts/**` : artefacts de VM vérifiés par le magasin (#298). */
export const PASSAGE_NOMME = Object.freeze([
  /^\/vendor\/v86\/artefacts\/v86-[0-9a-f]{16}\.wasm$/,
  /^\/vendor\/v86\/artefacts\/seabios-[0-9a-f]{16}\.bin$/,
  /^\/vendor\/v86\/artefacts\/vgabios-[0-9a-f]{16}\.bin$/,
  /^\/vendor\/v86\/artefacts\/linux4-[0-9a-f]{16}\.iso$/,
]);

const TYPES = new Map([
  [".ico", "image/vnd.microsoft.icon"],
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".bin", "application/octet-stream"],
  [".iso", "application/octet-stream"],
]);
export function typeDe(chemin) {
  const point = chemin.lastIndexOf(".");
  return TYPES.get(point < 0 ? "" : chemin.slice(point)) ?? "application/octet-stream";
}
export const sha256 = (octets) => createHash("sha256").update(octets).digest("hex");

function lister(dossier) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const complet = join(dossier, nom);
    if (statSync(complet).isDirectory()) sortie.push(...lister(complet));
    else sortie.push(complet);
  }
  return sortie;
}

let baseEnMemoire = null;
/** L'arbre publié, relu une fois : `Map<chemin, { disque }>` (les octets ne sont lus qu'à la demande). */
export function arbreDeBase() {
  if (baseEnMemoire) return baseEnMemoire;
  const base = new Map();
  for (const complet of lister(ARBRE_PUBLIE)) {
    base.set("/" + relative(ARBRE_PUBLIE, complet).split(sep).join("/"), { disque: complet });
  }
  baseEnMemoire = base;
  return base;
}
export function reglesHeadersPubliees() {
  return analyserHeaders(readFileSync(join(ARBRE_PUBLIE, "_headers"), "utf8"));
}

/** En-têtes de production d'un chemin ; une SEULE fixture déroge (page sans CSP, épreuve L1). */
export function entetesDe(regles, chemin) {
  const entetes = enTetesPour(regles, chemin);
  if (chemin === "/spike/sans-csp.html") {
    for (const nom of Object.keys(entetes)) if (nom.toLowerCase() === "content-security-policy") delete entetes[nom];
  }
  if (chemin === "/spike/sans-coop.html") {
    for (const nom of Object.keys(entetes)) if (nom.toLowerCase() === "cross-origin-opener-policy") delete entetes[nom];
  }
  return entetes;
}

export function estEnPassage(chemin) {
  return chemin.startsWith("/artifacts/") || PASSAGE_NOMME.some((m) => m.test(chemin));
}

/**
 * @param {object} o
 * @param {number} o.sequence numéro de publication (monotone)
 * @param {number} [o.plancher] plancher de révocation porté par CE script
 * @param {Record<string, string|Buffer|null>} [o.surcharges] chemin → octets (null = fichier retiré)
 * @param {boolean} [o.retrait] script de retrait (kill-switch)
 * @param {object} [o.variante] mutant du SW
 * @param {object} [o.faute] faute injectée dans le SW
 * @param {boolean} [o.sansFixtures]
 */
export function fabriquerGeneration({
  sequence,
  plancher = 0,
  surcharges = {},
  retrait = false,
  variante = {},
  faute = {},
  sansFixtures = false,
}) {
  const regles = reglesHeadersPubliees();
  /** @type {Map<string, Buffer>} */
  const fichiers = new Map();
  const base = arbreDeBase();
  for (const [chemin, { disque }] of base) {
    if (EXCLUS_DE_LA_RESERVE.some((e) => e.chemin === chemin)) continue;
    if (estEnPassage(chemin)) continue;
    fichiers.set(chemin, readFileSync(disque));
  }
  if (!sansFixtures) {
    for (const complet of lister(PAGES)) {
      fichiers.set("/spike/" + relative(PAGES, complet).split(sep).join("/"), readFileSync(complet));
    }
  }
  // La version de la réserve vue de la page ET du Worker : le module que les deux importent.
  const version = `pub-${String(sequence).padStart(4, "0")}`;
  fichiers.set(
    "/spike/version-reserve.mjs",
    Buffer.from(`export const VERSION = ${JSON.stringify(version)};\nexport const SEQUENCE = ${sequence};\n`),
  );
  for (const [chemin, octets] of Object.entries(surcharges)) {
    if (octets === null) fichiers.delete(chemin);
    else fichiers.set(chemin, Buffer.from(octets));
  }

  const profils = [];
  const indexProfil = new Map();
  const liste = {};
  for (const [chemin, octets] of [...fichiers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entetes = entetesDe(regles, chemin);
    const cle = JSON.stringify(entetes);
    if (!indexProfil.has(cle)) {
      indexProfil.set(cle, profils.length);
      profils.push(entetes);
    }
    liste[chemin] = {
      taille: octets.byteLength,
      sha256: sha256(octets),
      type: typeDe(chemin),
      profil: indexProfil.get(cle),
    };
  }
  // `/` sert la page d'index : alias, mêmes octets, mêmes en-têtes.
  if (liste["/index.html"]) liste["/"] = { alias: "/index.html" };

  const config = {
    version,
    sequence,
    plancher,
    retrait,
    liste: retrait ? {} : liste,
    profils,
    passage: PASSAGE_NOMME.map((m) => m.source),
    variante,
    faute,
  };
  const modele = readFileSync(join(BANC, "sw-modele.js"), "utf8");
  const script = modele.replace("/*__CONFIG__*/ null", JSON.stringify(config));
  if (script === modele) throw new Error("modèle du SW sans point d'injection");
  const taille = Object.values(liste).reduce((somme, e) => somme + (e.taille ?? 0), 0);
  return {
    sequence,
    version,
    plancher,
    fichiers,
    liste,
    script: Buffer.from(script),
    config,
    entrees: Object.values(liste).filter((e) => !e.alias).length,
    taille,
  };
}
