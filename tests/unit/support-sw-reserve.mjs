// SUPPORT des épreuves du Service Worker de la coquille (#299, ADR 0048) : le script du SW du PRODUIT
// (`tools/reserve/sw-coquille.js`, la source que la publication instancie) est exécuté TEL QUEL dans un
// `vm`, avec `caches`, `fetch`, `crypto` et `self` factices. Rien n'est réécrit : ce qui est éprouvé
// est le texte que la campagne `reserve` mute.
//
// La CONFIGURATION de ces épreuves est fabriquée ICI, sans passer par le générateur
// (`tools/publier-reserve.mjs`) : une épreuve du SW ne doit pas rougir ni verdir à cause du générateur,
// et réciproquement. Le seul contrat partagé est le point d'injection `/*__CONFIG__*/ null`.

import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const ORIGINE = "https://coquille.test";
export const SCRIPT_DU_SW = new URL("../../tools/reserve/sw-coquille.js", import.meta.url);

export const sha256 = (octets) => createHash("sha256").update(octets).digest("hex");
export const octets = (texte) => Buffer.from(texte, "utf8");

/** En-têtes d'un profil de la liste : de quoi vérifier qu'ils sont REJOUÉS et non lus du réseau. */
export const PROFIL_DE_PAGE = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; script-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-cache",
});
export const PROFIL_DE_CODE = Object.freeze({ "Cache-Control": "no-cache" });

/**
 * Une CONFIGURATION de SW à partir de fichiers `{ chemin: texte }`. `identite` dérive du contenu
 * (comme le fait le générateur) pour que deux contenus différents ne partagent jamais un nom.
 */
export function configurer(
  fichiers,
  {
    sequence = 1,
    plancher = 0,
    retrait = false,
    identite,
    prefixesAnciens = [],
    passage = ["^/vendor/v86/artefacts/v86-[0-9a-f]{16}\\.wasm$"],
  } = {},
) {
  const liste = {};
  for (const [chemin, texte] of Object.entries(fichiers)) {
    const corps = octets(texte);
    liste[chemin] = {
      taille: corps.byteLength,
      sha256: sha256(corps),
      type: chemin.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/javascript; charset=utf-8",
      profil: chemin.endsWith(".html") ? 0 : 1,
    };
  }
  return {
    identite: identite ?? sha256(JSON.stringify(liste)).slice(0, 32),
    sequence,
    plancher,
    retrait,
    liste: retrait ? {} : liste,
    alias: fichiers["/index.html"] === undefined ? {} : { "/": "/index.html" },
    profils: [PROFIL_DE_PAGE, PROFIL_DE_CODE],
    passage,
    prefixesAnciens,
  };
}

/** Le texte du SW du produit, avec sa configuration. */
export function scriptAvec(config) {
  const modele = readFileSync(SCRIPT_DU_SW, "utf8");
  const script = modele.replace("/*__CONFIG__*/ null", JSON.stringify(config));
  if (script === modele) throw new Error("le modèle du SW n'a pas de point d'injection");
  return script;
}

/** Un `Cache` et un `CacheStorage` factices, avec le journal de ce qu'on leur fait. */
function fabriquerLesCaches(operations) {
  const magasins = new Map();
  const cle = (requete) =>
    typeof requete === "string" ? requete : (requete.url ?? String(requete));
  const fabriquerCache = (nom) => {
    const entrees = magasins.get(nom);
    return {
      async match(requete) {
        const entree = entrees.get(cle(requete));
        return entree ? new Response(Buffer.from(entree)) : undefined;
      },
      async put(requete, reponse) {
        const corps = Buffer.from(await reponse.arrayBuffer());
        operations.push(["put", nom, new URL(cle(requete)).pathname]);
        entrees.set(cle(requete), corps);
      },
      async delete(requete) {
        operations.push(["delete-entree", nom, new URL(cle(requete)).pathname]);
        return entrees.delete(cle(requete));
      },
      async keys() {
        return [...entrees.keys()].map((url) => ({ url }));
      },
    };
  };
  return {
    magasins,
    api: {
      async open(nom) {
        operations.push(["open", nom]);
        if (!magasins.has(nom)) magasins.set(nom, new Map());
        return fabriquerCache(nom);
      },
      async has(nom) {
        return magasins.has(nom);
      },
      async delete(nom) {
        operations.push(["delete", nom]);
        return magasins.delete(nom);
      },
      async keys() {
        return [...magasins.keys()];
      },
    },
  };
}

/**
 * Un SW instancié. `reseau` : `{ chemin: { statut?, corps?, entetes?, redirection? } | Error }` ; un chemin
 * absent répond 404 ; `reseau.coupe = true` fait lever un `TypeError` à tout `fetch` (hors connexion).
 */
export function instancier(config, { reseau = {}, caches: initiaux = {}, clients = [] } = {}) {
  const operations = [];
  const appels = [];
  const compteurs = { digest: 0, skipWaiting: 0, claim: 0, desinscriptions: 0 };
  const ecouteurs = new Map();
  const { magasins, api } = fabriquerLesCaches(operations);
  for (const [nom, fichiers] of Object.entries(initiaux)) {
    magasins.set(
      nom,
      new Map(Object.entries(fichiers).map(([url, corps]) => [url, Buffer.from(corps)])),
    );
  }
  const messagesAuxClients = [];
  const sujets = {
    reseau,
    fetch: async (requete, init = {}) => {
      const url = new URL(typeof requete === "string" ? requete : requete.url, ORIGINE);
      const methode = init.method ?? requete.method ?? "GET";
      appels.push({
        url: url.href,
        chemin: url.pathname,
        methode,
        cache: init.cache ?? requete.cache,
        credentials: init.credentials ?? requete.credentials,
        redirect: init.redirect ?? requete.redirect,
      });
      if (reseau.coupe === true) throw new TypeError("Failed to fetch");
      const regle = reseau[url.pathname];
      if (regle instanceof Error) throw regle;
      if (regle === undefined) return new Response("absent", { status: 404 });
      const entetes = new Headers(regle.entetes ?? {});
      if (regle.redirection) {
        entetes.set("Location", regle.redirection);
        return new Response(null, { status: regle.statut ?? 302, headers: entetes });
      }
      return new Response(regle.corps === undefined ? "ok" : regle.corps, {
        status: regle.statut ?? 200,
        headers: entetes,
      });
    },
  };
  const sous = webcrypto.subtle;
  const soi = {
    location: new URL("/sw-coquille.mjs", ORIGINE),
    addEventListener: (type, fn) => ecouteurs.set(type, fn),
    skipWaiting: () => {
      compteurs.skipWaiting += 1;
      return Promise.resolve();
    },
    clients: {
      claim: () => {
        compteurs.claim += 1;
        return Promise.resolve();
      },
      matchAll: async () =>
        clients.map((client) => ({
          ...client,
          postMessage: (message) => messagesAuxClients.push(message),
        })),
    },
    registration: {
      unregister: async () => {
        compteurs.desinscriptions += 1;
        operations.push(["unregister"]);
        return true;
      },
    },
  };
  const contexte = vm.createContext({
    self: soi,
    caches: api,
    fetch: sujets.fetch,
    crypto: {
      subtle: {
        digest: (algorithme, donnees) => {
          compteurs.digest += 1;
          return sous.digest(algorithme, donnees);
        },
      },
    },
    Response,
    Request,
    Headers,
    URL,
    DOMException,
    TypeError,
    Error,
    Promise,
    Uint8Array,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(scriptAvec(config), contexte, { filename: "sw-coquille.js" });
  const attendre = async (type, evenement) => {
    const attentes = [];
    evenement.waitUntil = (promesse) => attentes.push(Promise.resolve(promesse));
    const ecouteur = ecouteurs.get(type);
    if (ecouteur) ecouteur(evenement);
    await Promise.all(attentes);
  };
  return {
    config,
    operations,
    appels,
    compteurs,
    caches: magasins,
    messagesAuxClients,
    ecouteurs,
    reseau,
    nomDuCache: `reserve-${config.identite}`,
    /** `install` : rend `null`, ou l'erreur qui a fait échouer l'installation. */
    async installer() {
      try {
        await attendre("install", {});
        return null;
      } catch (erreur) {
        return erreur;
      }
    },
    async activer() {
      await attendre("activate", {});
    },
    /** Une requête d'un client : rend `{ reponse, repondu }` (`repondu` faux = le SW n'a pas répondu). */
    async requete(
      chemin,
      { methode = "GET", destination = "", origine = ORIGINE, redirect = "follow", entetes } = {},
    ) {
      const demande = new Request(new URL(chemin, origine), {
        method: methode,
        redirect,
        headers: entetes,
      });
      Object.defineProperty(demande, "destination", { value: destination });
      let reponse = null;
      let repondu = false;
      const evenement = {
        request: demande,
        respondWith: (promesse) => {
          repondu = true;
          reponse = Promise.resolve(promesse);
        },
      };
      const ecouteur = ecouteurs.get("fetch");
      if (ecouteur) ecouteur(evenement);
      if (!repondu) return { repondu: false, reponse: null };
      try {
        return { repondu: true, reponse: await reponse };
      } catch (erreur) {
        return { repondu: true, reponse: null, erreur };
      }
    },
    /** Un message d'un client ; rend la réponse reçue sur le port, ou `undefined` s'il n'y en a pas. */
    async message(
      donnees,
      { source = { type: "window", frameType: "top-level" }, ports = 1 } = {},
    ) {
      let recu;
      const port = { postMessage: (valeur) => (recu = valeur) };
      const attentes = [];
      const evenement = {
        data: donnees,
        source,
        ports: ports === 0 ? [] : Array.from({ length: ports }, () => port),
        waitUntil: (promesse) => attentes.push(Promise.resolve(promesse)),
      };
      const ecouteur = ecouteurs.get("message");
      if (ecouteur) ecouteur(evenement);
      await Promise.all(attentes);
      await new Promise((resoudre) => setImmediate(resoudre));
      return recu;
    },
  };
}

/** Un SW installé et actif sur un réseau qui sert exactement `fichiers`. */
export async function installe(fichiers, options = {}, reseauEnPlus = {}) {
  const config = configurer(fichiers, options);
  const reseau = {};
  for (const [chemin, texte] of Object.entries(fichiers)) reseau[chemin] = { corps: texte };
  if (fichiers["/index.html"] !== undefined) reseau["/"] = { corps: fichiers["/index.html"] };
  Object.assign(reseau, reseauEnPlus);
  const sw = instancier(config, { reseau });
  const erreur = await sw.installer();
  if (erreur) throw erreur;
  await sw.activer();
  return sw;
}

export const FICHIERS = Object.freeze({
  "/index.html":
    "<!doctype html><title>coquille</title><script type=module src=/main.mjs></script>",
  "/main.mjs": "export const MAIN = 1;\n",
  "/runtime-worker.mjs": "export const WORKER = 1;\n",
  "/src/coquille/a.mjs": "export const A = 1;\n",
});

export const texteDe = async (reponse) => Buffer.from(await reponse.arrayBuffer()).toString("utf8");
