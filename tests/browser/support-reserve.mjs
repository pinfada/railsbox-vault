// SUPPORT des épreuves navigateur de la RÉSERVE (#299, ADR 0048) : l'arbre PUBLIÉ de la coquille (construit
// une fois par `tools/publier.mjs`), une ORIGINE CONTRÔLABLE qui le sert sous les en-têtes de production
// (`_headers`, jamais ceux du serveur de développement), et sait mentir, tomber, retirer.
//
// Les « générations » sont des publications successives en mémoire : même arbre, autre séquence, autre
// contenu, autre plancher, script de retrait. « Réseau coupé » = ARRÊTER l'origine (jamais `setOffline` :
// Firefox l'ignore quand un SW est installé, WebKit coupe aussi ce que le SW sert — ADR 0048 § 14).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, firefox, webkit } from "@playwright/test";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { analyserHeaders, enTetesPour } from "../../tools/publier-en-tetes.mjs";
import {
  CHEMIN_DU_MODULE_DE_PAGE,
  CHEMIN_DU_SW,
  fabriquerLaReserve,
  fabriquerLeScriptDeRetrait,
  moduleDePage,
} from "../../tools/publier-reserve.mjs";

export const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PORT_COQUILLE = 4193;
/** Un port par moteur : les projets `reserve-*` tournent en parallèle, et une origine n'est jamais partagée. */
export const portDe = (nomDuMoteur) =>
  ({ chromium: 4193, firefox: 4195, webkit: 4197 })[nomDuMoteur];
export const PORT_APPLICATION = 4194;
export const ORIGINE_COQUILLE = `http://127.0.0.1:${PORT_COQUILLE}`;
const SORTIE = join(RACINE, "artifacts", "publication-reserve-navigateur");

const TYPES = {
  ".ico": "image/vnd.microsoft.icon",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};
const typeDe = (chemin) =>
  TYPES[chemin.slice(chemin.lastIndexOf("."))] ?? "application/octet-stream";

function lister(racine, dossier = racine) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const complet = join(dossier, nom);
    if (statSync(complet).isDirectory()) sortie.push(...lister(racine, complet));
    else sortie.push(complet);
  }
  return sortie;
}

let base = null;
/** L'arbre publié, construit UNE fois par processus : `{ fichiers, regles }`. */
export function baseDePublication() {
  if (base) return base;
  mkdirSync(SORTIE, { recursive: true });
  execFileSync(
    process.execPath,
    [
      "tools/publier.mjs",
      "--sortie",
      SORTIE,
      "--origine-application",
      `http://localhost:${PORT_APPLICATION}`,
      "--origine-coquille",
      ORIGINE_COQUILLE,
      "--tolerer-incomplet",
      "--sequence",
      "1",
    ],
    { cwd: RACINE, stdio: "pipe" },
  );
  const arbre = join(SORTIE, "coquille");
  const fichiers = new Map();
  for (const complet of lister(arbre)) {
    fichiers.set("/" + relative(arbre, complet).split(sep).join("/"), readFileSync(complet));
  }
  const regles = analyserHeaders(fichiers.get("/_headers").toString("utf8"));
  base = { fichiers, regles };
  return base;
}

export const entetesDeProduction = (chemin) => enTetesPour(baseDePublication().regles, chemin);

/**
 * Une publication. `surcharges` : chemin → octets (`null` retire le fichier) ; `transformerLeScript` change
 * le TEXTE du SW (une faute injectée : SW muet, `skipWaiting`) — jamais pour la configuration nominale.
 */
export function fabriquerGeneration({
  sequence = 1,
  plancher = 0,
  surcharges = {},
  retrait = false,
  prefixesAnciens = [],
  transformerLeScript = (texte) => texte,
} = {}) {
  const { fichiers: depart, regles } = baseDePublication();
  const fichiers = new Map(depart);
  fichiers.delete(CHEMIN_DU_SW);
  fichiers.set(CHEMIN_DU_MODULE_DE_PAGE, Buffer.from(moduleDePage(sequence)));
  for (const [chemin, octets] of Object.entries(surcharges)) {
    if (octets === null) fichiers.delete(chemin);
    else fichiers.set(chemin, Buffer.from(octets));
  }
  const reserve = fabriquerLaReserve({
    fichiers,
    entetesDe: (chemin) => enTetesPour(regles, chemin),
    sequence,
    plancher,
    prefixesAnciens,
  });
  const script = retrait ? fabriquerLeScriptDeRetrait({ prefixesAnciens }) : reserve.script;
  return {
    sequence,
    plancher,
    fichiers,
    reserve,
    script: Buffer.from(transformerLeScript(script)),
  };
}

export const MAUVAIS = "export const V = 'MAUVAIS';\n";

/** L'origine CONTRÔLABLE. Un journal de chaque requête reçue : « 0 requête à l'origine » se MESURE ici. */
export class Origine {
  constructor({ port = PORT_COQUILLE, hote = "127.0.0.1", dossierArtefacts = null } = {}) {
    this.port = port;
    this.hote = hote;
    this.origine = `http://${hote}:${port}`;
    this.generation = null;
    this.hostile = false;
    this.regles = new Map();
    this.journal = [];
    this.sockets = new Set();
    this.serveur = null;
    this.dossierArtefacts = dossierArtefacts;
  }
  publier(generation) {
    this.generation = generation;
  }
  /** Réglage par chemin : `{ statut }`, `{ corps, type }`, `{ redirection }`. `null` l'efface. */
  regler(chemin, reglage) {
    if (reglage === null) this.regles.delete(chemin);
    else this.regles.set(chemin, reglage);
  }
  requetes(filtre = () => true) {
    return this.journal.filter(filtre);
  }
  vider() {
    this.journal.length = 0;
  }
  async demarrer() {
    this.serveur = createServer((requete, reponse) => this.#traiter(requete, reponse));
    this.serveur.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise((ok, ko) => {
      this.serveur.once("error", ko);
      this.serveur.listen(this.port, this.hote, ok);
    });
  }
  async arreter() {
    if (!this.serveur) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise((ok) => this.serveur.close(ok));
    this.serveur = null;
  }
  #traiter(requete, reponse) {
    const brut = (requete.url ?? "/").split("?")[0];
    this.journal.push({
      methode: requete.method,
      chemin: brut,
      destination: requete.headers["sec-fetch-dest"] ?? null,
    });
    const reglage = this.regles.get(brut);
    if (reglage?.statut) {
      reponse.writeHead(reglage.statut, { "Cache-Control": "no-store" }).end("statut imposé");
      return;
    }
    if (reglage?.redirection) {
      reponse.writeHead(302, { Location: reglage.redirection }).end();
      return;
    }
    const chemin = brut === "/" ? "/index.html" : brut;
    const entetes = { ...entetesDeProduction(chemin), ...(reglage?.entetes ?? {}) };
    if (reglage?.corps !== undefined) {
      reponse
        .writeHead(200, { "Content-Type": reglage.type ?? typeDe(chemin), ...entetes })
        .end(reglage.corps);
      return;
    }
    const { generation } = this;
    if (brut === CHEMIN_DU_SW) {
      reponse
        .writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", ...entetes })
        .end(generation.script);
      return;
    }
    if (this.dossierArtefacts && brut.startsWith("/artifacts/") && !brut.includes("..")) {
      const complet = join(RACINE, decodeURIComponent(brut.slice(1)));
      if (existsSync(complet) && statSync(complet).isFile()) {
        reponse
          .writeHead(200, { "Content-Type": typeDe(complet), ...entetes })
          .end(readFileSync(complet));
        return;
      }
    }
    const fichier = generation.fichiers.get(chemin);
    const liste = generation.reserve.liste[chemin] !== undefined;
    if (fichier) {
      const corps = this.hostile && liste ? Buffer.from(MAUVAIS) : fichier;
      reponse
        .writeHead(200, {
          "Content-Type": typeDe(chemin),
          "Content-Length": corps.byteLength,
          ...entetes,
        })
        .end(corps);
      return;
    }
    reponse
      .writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
      .end("Not found");
  }
}

/** Ce qu'une épreuve a besoin de savoir de l'état de la coquille, lu dans le relevé public. */
export async function lireLeReleve(page) {
  return page.evaluate(() => {
    const noeud = document.querySelector("#coquille-rapport");
    return {
      coquille: document.documentElement.dataset.coquille,
      rapport: noeud?.textContent ? JSON.parse(noeud.textContent) : null,
      bandeau: document.querySelector("#reserve-etat")?.dataset.etat ?? null,
      refus: document.querySelector("#reserve-refus")?.dataset.code ?? null,
      workers: window.__workersCrees ?? 0,
    };
  });
}

/** Compte les `new Worker` de la page, dès le premier instant : « zéro Worker, zéro clé » se mesure. */
export const SONDE_DES_WORKERS = () => {
  window.__workersCrees = 0;
  const Natif = window.Worker;
  window.Worker = class extends Natif {
    constructor(...arguments_) {
      window.__workersCrees += 1;
      super(...arguments_);
    }
  };
};

const ETATS_EN_ROUTE = /^(demarrage|preparation-hors-connexion)$/;

/** Attend un état final de la coquille (le rechargement de la première visite est tolérant). */
export async function attendreLaCoquille(page, { delaiMs = 60_000 } = {}) {
  const fin = Date.now() + delaiMs;
  let dernier = null;
  while (Date.now() < fin) {
    try {
      dernier = await lireLeReleve(page);
      if (dernier.coquille && !ETATS_EN_ROUTE.test(dernier.coquille)) return dernier;
    } catch {
      /* navigation en cours */
    }
    await new Promise((resoudre) => setTimeout(resoudre, 150));
  }
  throw new Error(`la coquille n'a pas atteint un état final : ${JSON.stringify(dernier)}`);
}

export async function jusqua(condition, { delaiMs = 20_000, pasMs = 100 } = {}) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    if (await condition()) return true;
    await new Promise((resoudre) => setTimeout(resoudre, pasMs));
  }
  return false;
}

const MOTEURS = { chromium, firefox, webkit };

/**
 * Un navigateur NEUF (Firefox garde un état de connexion après un serveur arrêté : mesuré). Avec
 * `profil`, un contexte PERSISTANT : fermer puis rouvrir le même profil est « fermer et rouvrir le navigateur ».
 */
export async function ouvrirUnNavigateur(nomDuMoteur, { profil = null, options = {} } = {}) {
  const moteur = MOTEURS[nomDuMoteur];
  let navigateur = null;
  let contexte;
  if (profil) contexte = await moteur.launchPersistentContext(profil, options);
  else {
    navigateur = await moteur.launch();
    contexte = await navigateur.newContext(options);
  }
  await contexte.addInitScript(SONDE_DES_WORKERS);
  return {
    contexte,
    async page() {
      const page = await contexte.newPage();
      page.erreurs = [];
      page.on("pageerror", (erreur) => page.erreurs.push(erreur.message));
      return page;
    },
    async fermer() {
      await contexte.close();
      await navigateur?.close();
    },
  };
}

/** Visite la coquille et attend son état final (première visite : installation, puis rechargement). */
export async function visiter(page, origine, chemin = "/index.html") {
  await page.goto(origine.origine + chemin, { waitUntil: "load" });
  return attendreLaCoquille(page);
}

/** `true` si ce projet est WebKit : le build Playwright n'a pas d'OPFS (déverrouillage non prouvable). */
export const estWebkit = (nomDuMoteur) => nomDuMoteur === "webkit";
