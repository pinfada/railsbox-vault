// SERVICE WORKER DE LA COQUILLE (#299, ADR 0048) — MODÈLE. Un seul fichier CLASSIQUE, sans `import`, servi
// à `/sw-coquille.mjs`. `tools/publier-reserve.mjs` remplace le point d'injection de `CONFIG` ci-dessous par la configuration :
// la liste épinglée (chemin → taille, SHA-256, type, profil d'en-têtes), l'identité de contenu, la
// séquence de publication, le plancher de révocation et les anciens préfixes de cache.
//
// Ce que ce script FAIT, et ce qu'il ne fait jamais :
//  - il sert un fichier listé depuis des octets RELUS et RE-HACHÉS à chaque service : les octets hachés
//    sont les octets rendus (§ 3) ;
//  - la garde est FERMÉE : tout ce qui n'est ni listé ni un passage nommé de DONNÉES est refusé (§ 4) ;
//  - ni `skipWaiting()` ni `clients.claim()` : une version devient active quand TOUS les clients de
//    l'ancienne ont disparu (§ 6) ;
//  - le cache est nommé par le CONTENU publié et n'est jamais écrasé (§ 5) ;
//  - ses messages sont un vocabulaire FERMÉ, et il ne voit jamais une clé (§§ 7 et 12).
"use strict";

const CONFIG = /*__CONFIG__*/ null;

const PREFIXE_DE_CACHE = "reserve-";
const NOM_DU_CACHE = PREFIXE_DE_CACHE + CONFIG.identite;
const DESTINATIONS_EXECUTABLES = new Set([
  "script",
  "worker",
  "sharedworker",
  "serviceworker",
  "audioworklet",
  "paintworklet",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "manifest",
  "xslt",
]);
// Sous `/artifacts/` (données) : aucun type exécutable, wasm compris. Passage nommé (`v86.wasm`…) :
// `application/wasm` est LE type attendu, seuls les types de document et de script sont refusés.
const TYPES_REFUSES_SOUS_ARTIFACTS = /(javascript|ecmascript|wasm|html|xml|css)/i;
const TYPES_REFUSES_EN_PASSAGE_NOMME = /(javascript|ecmascript|html|xml|css)/i;
const PASSAGES_NOMMES = CONFIG.passage.map((source) => new RegExp(source));
const TYPES_DE_MESSAGE = ["version", "verifier", "reparer", "clients", "journal"];
const journal = { refus: [], messagesRefuses: 0, horsOrigine: 0 };

function hex(tampon) {
  let sortie = "";
  for (const octet of new Uint8Array(tampon)) sortie += octet.toString(16).padStart(2, "0");
  return sortie;
}
async function sha256(octets) {
  return hex(await crypto.subtle.digest("SHA-256", octets));
}
function cleDeCache(chemin) {
  return new Request(new URL(chemin, self.location.origin));
}
function refus(code, detail) {
  journal.refus.push({ code, detail });
  if (journal.refus.length > 200) journal.refus.shift();
  return new Response("refus de la coquille : " + code, {
    status: 503,
    headers: { "X-Vault-Refus": code, "Cache-Control": "no-store", "Content-Type": "text/plain" },
  });
}
function entetesDe(entree) {
  const entetes = new Headers(CONFIG.profils[entree.profil]);
  entetes.set("Content-Type", entree.type);
  entetes.set("Content-Length", String(entree.taille));
  return entetes;
}

// ---------------------------------------------------------------------------------------------
// Lecture vérifiée, téléchargement vérifié : la TAILLE d'abord (elle borne le coût avant tout
// hachage), l'empreinte ensuite. Une entrée n'est écrite qu'APRÈS vérification.
// ---------------------------------------------------------------------------------------------
async function lireVerifiee(cache, chemin) {
  const entree = CONFIG.liste[chemin];
  const reponse = await cache.match(cleDeCache(chemin));
  if (!reponse) return { etat: "manquante" };
  const octets = await reponse.arrayBuffer();
  if (octets.byteLength !== entree.taille) return { etat: "alteree", cause: "taille" };
  if ((await sha256(octets)) !== entree.sha256) return { etat: "alteree", cause: "empreinte" };
  return { etat: "ok", octets };
}
async function telechargerVerifie(chemin) {
  const entree = CONFIG.liste[chemin];
  const reponse = await fetch(chemin, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (reponse.status !== 200) throw new Error("statut " + reponse.status + " pour " + chemin);
  const octets = await reponse.arrayBuffer();
  if (octets.byteLength !== entree.taille) throw new Error("taille différente pour " + chemin);
  if ((await sha256(octets)) !== entree.sha256)
    throw new Error("empreinte différente pour " + chemin);
  return octets;
}
/**
 * Complète un cache : une entrée déjà valide est gardée, une entrée manquante ou altérée est refaite
 * depuis le réseau, vérifiée, PUIS écrite. `tolerant` (réparation) collecte les échecs ; sinon (installation)
 * le premier échec jette.
 */
async function completer(cache, tolerant) {
  const reparees = [];
  const echecs = [];
  for (const chemin of Object.keys(CONFIG.liste)) {
    const lu = await lireVerifiee(cache, chemin);
    if (lu.etat === "ok") continue;
    try {
      if (lu.etat === "alteree") await cache.delete(cleDeCache(chemin));
      const octets = await telechargerVerifie(chemin);
      await cache.put(cleDeCache(chemin), new Response(octets));
      reparees.push(chemin);
    } catch (erreur) {
      if (!tolerant) throw erreur;
      echecs.push(chemin);
    }
  }
  return { reparees, echecs };
}

// ---------------------------------------------------------------------------------------------
// Installation : tout ou rien. Un cache de même identité qui existe déjà n'est JAMAIS supprimé ; un
// échec ne supprime que le cache que CETTE installation a créé.
// ---------------------------------------------------------------------------------------------
async function installer() {
  if (CONFIG.retrait) return; // le script de retrait n'installe rien
  const existait = await caches.has(NOM_DU_CACHE);
  const cache = await caches.open(NOM_DU_CACHE);
  try {
    await completer(cache, false);
  } catch (erreur) {
    if (!existait) await caches.delete(NOM_DU_CACHE);
    throw erreur;
  }
}
self.addEventListener("install", (evenement) => {
  evenement.waitUntil(installer());
});

// ---------------------------------------------------------------------------------------------
// Activation : à ce moment, tous les clients de l'ancienne version ont disparu (§ 6). Seuls sont
// supprimés les caches `reserve-*` d'une AUTRE identité et les anciens préfixes NOMMÉS.
// ---------------------------------------------------------------------------------------------
function estDuProduit(nom) {
  return (
    nom.startsWith(PREFIXE_DE_CACHE) ||
    CONFIG.prefixesAnciens.some((prefixe) => nom.startsWith(prefixe))
  );
}
async function nettoyer() {
  for (const nom of await caches.keys()) {
    if (nom !== NOM_DU_CACHE && estDuProduit(nom)) await caches.delete(nom);
  }
}
async function retirer() {
  // Script de retrait : les caches d'abord, la désinscription ensuite. Coupé entre les deux, le SW de
  // retrait reste actif sans cache : la page le reconnaît, et le geste de la personne achève (idempotent).
  for (const nom of await caches.keys()) if (estDuProduit(nom)) await caches.delete(nom);
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage({ type: "retire" });
}
self.addEventListener("activate", (evenement) => {
  evenement.waitUntil(CONFIG.retrait ? retirer() : nettoyer());
});

// ---------------------------------------------------------------------------------------------
// Service d'un fichier listé : octets relus, RE-HACHÉS, puis rendus.
// ---------------------------------------------------------------------------------------------
async function servir(chemin) {
  const cache = await caches.open(NOM_DU_CACHE);
  const lu = await lireVerifiee(cache, chemin);
  if (lu.etat === "manquante") return refus("RESERVE_INCOMPLETE", chemin);
  if (lu.etat === "alteree") return refus("RESERVE_ALTEREE", chemin + " (" + lu.cause + ")");
  return new Response(lu.octets, { status: 200, headers: entetesDe(CONFIG.liste[chemin]) });
}

// ---------------------------------------------------------------------------------------------
// Passage de DONNÉES : `/artifacts/**` et les quatre artefacts de VM nommés. Jamais une destination
// exécutable, jamais une redirection suivie, jamais un type exécutable rendu.
// ---------------------------------------------------------------------------------------------
function cheminSuspect(chemin) {
  // L'URL normalise `..`, `%2e%2e` et l'antislash (réécrit en `/`) : `pathname` n'en porte jamais. Elle ne
  // décode pas `%2f`, `%5c` ni `%00`, que certains hôtes décodent : ce sont ceux-là que la garde lit.
  return /%2e|%2f|%5c|%00/i.test(chemin);
}
async function passer(requete, url) {
  const donnees = url.pathname.startsWith("/artifacts/");
  if (DESTINATIONS_EXECUTABLES.has(requete.destination)) {
    return refus("PASSAGE_DESTINATION_EXECUTABLE", requete.destination + " " + url.pathname);
  }
  if (cheminSuspect(url.pathname)) return refus("PASSAGE_CHEMIN_SUSPECT", url.pathname);
  let reponse;
  try {
    reponse = await fetch(new Request(requete, { redirect: "manual" }));
  } catch {
    return Response.error(); // réseau coupé : l'échec reste un échec RÉSEAU (`TypeError` côté page)
  }
  if (reponse.type === "opaqueredirect" || (reponse.status >= 300 && reponse.status < 400)) {
    return refus("PASSAGE_REDIRECTION", url.pathname);
  }
  const type = reponse.headers.get("Content-Type") ?? "";
  const interdit = donnees ? TYPES_REFUSES_SOUS_ARTIFACTS : TYPES_REFUSES_EN_PASSAGE_NOMME;
  if (interdit.test(type)) return refus("PASSAGE_TYPE_EXECUTABLE", type);
  return reponse;
}
function enPassage(chemin) {
  return chemin.startsWith("/artifacts/") || PASSAGES_NOMMES.some((motif) => motif.test(chemin));
}

// ---------------------------------------------------------------------------------------------
// GARDE FERMÉE. La clé est le chemin EXACT, sans chaîne de requête, sans normalisation de casse.
// ---------------------------------------------------------------------------------------------
self.addEventListener("fetch", (evenement) => {
  if (CONFIG.retrait) return; // le script de retrait n'intercepte rien
  const requete = evenement.request;
  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) {
    journal.horsOrigine += 1;
    evenement.respondWith(refus("HORS_ORIGINE", url.origin));
    return;
  }
  const chemin = url.pathname;
  const cible = Object.hasOwn(CONFIG.liste, chemin)
    ? chemin
    : Object.hasOwn(CONFIG.alias, chemin)
      ? CONFIG.alias[chemin]
      : null;
  if (cible !== null) {
    evenement.respondWith(
      requete.method === "GET" ? servir(cible) : refus("METHODE", requete.method),
    );
    return;
  }
  if (enPassage(chemin)) {
    evenement.respondWith(
      requete.method === "GET" ? passer(requete, url) : refus("PASSAGE_METHODE", requete.method),
    );
    return;
  }
  evenement.respondWith(refus("HORS_LISTE", chemin));
});

// ---------------------------------------------------------------------------------------------
// Messages : vocabulaire FERMÉ, fenêtres de premier niveau de la coquille seulement, une réponse par
// le port reçu. `activer` et `skipWaiting` n'existent pas.
// ---------------------------------------------------------------------------------------------
async function verifierToutes() {
  const cache = await caches.open(NOM_DU_CACHE);
  const manquants = [];
  const alteres = [];
  for (const chemin of Object.keys(CONFIG.liste)) {
    const lu = await lireVerifiee(cache, chemin);
    if (lu.etat === "manquante") manquants.push(chemin);
    else if (lu.etat === "alteree") alteres.push(chemin);
  }
  return { ok: manquants.length === 0 && alteres.length === 0, manquants, alteres };
}
const IDENTITE = {
  version: CONFIG.identite,
  sequence: CONFIG.sequence,
  plancher: CONFIG.plancher,
  retrait: Boolean(CONFIG.retrait),
  entrees: Object.keys(CONFIG.liste).length,
};
function messageValide(evenement) {
  const source = evenement.source;
  const donnees = evenement.data;
  return (
    source !== null &&
    source !== undefined &&
    source.type === "window" &&
    source.frameType === "top-level" &&
    donnees !== null &&
    typeof donnees === "object" &&
    !Array.isArray(donnees) &&
    Object.keys(donnees).every((cle) => cle === "type" || cle === "id") &&
    (donnees.id === undefined || (typeof donnees.id === "string" && donnees.id.length <= 64)) &&
    TYPES_DE_MESSAGE.includes(donnees.type) &&
    evenement.ports?.length === 1
  );
}
self.addEventListener("message", (evenement) => {
  if (!messageValide(evenement)) {
    journal.messagesRefuses += 1;
    return; // un message mal formé ne reçoit AUCUNE réponse
  }
  const donnees = evenement.data;
  const port = evenement.ports[0];
  const repondre = (corps) => port.postMessage({ id: donnees.id ?? null, ...corps });
  if (donnees.type === "version") return repondre({ ...IDENTITE });
  if (donnees.type === "journal") return repondre({ journal });
  if (donnees.type === "clients") {
    evenement.waitUntil(
      self.clients
        .matchAll({ includeUncontrolled: true, type: "window" })
        .then((liste) => repondre({ fenetres: liste.length })),
    );
    return;
  }
  if (CONFIG.retrait) {
    return repondre({
      ...IDENTITE,
      ok: true,
      manquants: [],
      alteres: [],
      reparees: [],
      echecs: [],
    });
  }
  if (donnees.type === "reparer") {
    evenement.waitUntil(
      caches
        .open(NOM_DU_CACHE)
        .then((cache) => completer(cache, true))
        .then(({ reparees, echecs }) => repondre({ ok: echecs.length === 0, reparees, echecs })),
    );
    return;
  }
  evenement.waitUntil(verifierToutes().then((verdict) => repondre({ ...IDENTITE, ...verdict })));
});
