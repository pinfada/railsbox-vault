// MODÈLE du Service Worker de la coquille (SPIKE D1h — révision du défi C-K, #299).
//
// Un seul fichier CLASSIQUE, sans import. `banc/reserve.mjs` remplace la ligne `CONFIG` par la liste
// épinglée (taille, SHA-256, type, profil d'en-têtes de chaque fichier) et, pour les épreuves, par
// des VARIANTES (`config.variante.*`) qui sont les mutants de chaque garde. Aucune variante n'est
// active dans la configuration nominale ; une épreuve qui ne rougit pas sous sa variante ne prouve rien.
//
// Règles (DoR révisée, § 1 à 3) :
//   - pas de `skipWaiting`, pas de `clients.claim()` : la mise à jour attend la disparition de TOUS
//     les clients de l'ancienne version (règle, pas préférence) ;
//   - GARDE FERMÉE : toute requête de ce client qui n'est ni listée ni dans la liste de passage
//     nommée est REFUSÉE (la liste de passage n'accepte que des `fetch` de données, jamais une
//     destination exécutable) ;
//   - un fichier listé est rendu depuis des octets recalculés à chaque service.
"use strict";

const CONFIG = /*__CONFIG__*/ null;

const PREFIXE_DE_CACHE = "reserve-"; // préfixe RÉSERVÉ au produit : seul ce préfixe est supprimé
const NOM_DU_CACHE = PREFIXE_DE_CACHE + CONFIG.version;
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
const TYPES_REFUSES_EN_PASSAGE = /(javascript|ecmascript|wasm|html|xml|css)/i;
const journal = { refus: [], messagesRefuses: 0, horsOrigine: 0 };

function hex(tampon) {
  let sortie = "";
  for (const octet of new Uint8Array(tampon)) sortie += octet.toString(16).padStart(2, "0");
  return sortie;
}
async function sha256(octets) {
  return hex(await crypto.subtle.digest("SHA-256", octets));
}
function sansRequete(url) {
  return url.pathname; // clé = chemin, jamais la chaîne de requête, jamais une normalisation de casse
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
// Installation : tout ou rien, puis nettoyage du cache partiel (S7).
// ---------------------------------------------------------------------------------------------
async function installer() {
  if (CONFIG.retrait) return; // le script de retrait n'installe rien
  await caches.delete(NOM_DU_CACHE);
  const cache = await caches.open(NOM_DU_CACHE);
  try {
    if (CONFIG.faute?.ralentirInstallationMs) {
      await new Promise((r) => setTimeout(r, CONFIG.faute.ralentirInstallationMs));
    }
    let n = 0;
    for (const [chemin, entree] of Object.entries(CONFIG.liste)) {
      if (entree.alias) continue;
      const reponse = await fetch(chemin, {
        cache: CONFIG.variante?.installAvecCacheHttp ? "default" : "no-store",
        credentials: "omit",
        redirect: CONFIG.variante?.installSuitLesRedirections ? "follow" : "error",
      });
      if (reponse.status !== 200) throw new Error("statut " + reponse.status + " pour " + chemin);
      const octets = await reponse.arrayBuffer();
      if (!CONFIG.variante?.installIgnoreLaTaille && octets.byteLength !== entree.taille) {
        throw new Error("taille " + octets.byteLength + " ≠ " + entree.taille + " pour " + chemin);
      }
      if (!CONFIG.variante?.installAccepteUnEcart && (await sha256(octets)) !== entree.sha256) {
        throw new Error("empreinte différente pour " + chemin);
      }
      n += 1;
      if (CONFIG.faute?.quotaApres !== undefined && n > CONFIG.faute.quotaApres) {
        throw new DOMException("quota simulé", "QuotaExceededError");
      }
      await cache.put(new Request(new URL(chemin, self.location.origin)), new Response(octets));
    }
  } catch (erreur) {
    if (!CONFIG.variante?.cachePartielConserve) await caches.delete(NOM_DU_CACHE);
    throw erreur;
  }
}
self.addEventListener("install", (evenement) => {
  if (CONFIG.variante?.skipWaiting) self.skipWaiting(); // MUTANT : jamais dans la configuration nominale
  evenement.waitUntil(installer());
});

// ---------------------------------------------------------------------------------------------
// Activation : on ne supprime QUE les caches du produit qui ne sont pas ceux de cette version.
// ---------------------------------------------------------------------------------------------
async function nettoyer() {
  const noms = await caches.keys();
  for (const nom of noms) {
    const duProduit = CONFIG.variante?.supprimeTout ? true : nom.startsWith(PREFIXE_DE_CACHE);
    if (duProduit && nom !== NOM_DU_CACHE) await caches.delete(nom);
  }
}
async function retirer() {
  // Script de retrait (kill-switch). Ordre voulu : caches d'abord, désinscription ensuite — une
  // interruption entre les deux laisse une inscription sans cache (refusée au portail), jamais un
  // cache sans inscription... sauf sous la variante qui inverse l'ordre.
  if (CONFIG.variante?.retraitDesinscritAvant) {
    await self.registration.unregister();
    if (CONFIG.faute?.interrompreRetraitApresDesinscription) return; // coupure simulée
  }
  const noms = await caches.keys();
  for (const nom of noms) if (nom.startsWith(PREFIXE_DE_CACHE)) await caches.delete(nom);
  if (!CONFIG.variante?.retraitDesinscritAvant) {
    if (CONFIG.faute?.interrompreRetraitApresDesinscription) return;
    await self.registration.unregister();
  }
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage({ type: "retire" });
}
self.addEventListener("activate", (evenement) => {
  if (CONFIG.variante?.claim) evenement.waitUntil(self.clients.claim()); // MUTANT
  evenement.waitUntil(CONFIG.retrait ? retirer() : nettoyer());
});

// ---------------------------------------------------------------------------------------------
// Service : octets relus, RE-HACHÉS, puis rendus (les octets hachés sont les octets rendus).
// ---------------------------------------------------------------------------------------------
async function servir(chemin, entree) {
  const cache = await caches.open(NOM_DU_CACHE);
  const reponse = await cache.match(new Request(new URL(entree.alias ?? chemin, self.location.origin)));
  if (!reponse) return refus("RESERVE_INCOMPLETE", chemin);
  const octets = await reponse.arrayBuffer();
  const cible = entree.alias ? CONFIG.liste[entree.alias] : entree;
  if (!CONFIG.variante?.serviceSansTaille && octets.byteLength !== cible.taille) {
    return refus("RESERVE_ALTEREE", chemin);
  }
  if (!CONFIG.variante?.serviceSansHachage && (await sha256(octets)) !== cible.sha256) {
    return refus("RESERVE_ALTEREE", chemin);
  }
  return new Response(octets, { status: 200, headers: entetesDe(cible) });
}

function executable(requete) {
  return DESTINATIONS_EXECUTABLES.has(requete.destination);
}
function cheminSuspect(chemin) {
  // Encodages de séparateurs et de points : le navigateur a déjà normalisé `..` et `%2e%2e`, mais
  // PAS `%2f`, `%5c`, ni les antislashs, que certains hôtes décodent.
  return /%2e|%2f|%5c|\\|%00/i.test(chemin);
}
async function passer(requete, url) {
  const donnees = url.pathname.startsWith("/artifacts/");
  if (requete.method !== "GET") return refus("PASSAGE_METHODE", requete.method);
  if (!CONFIG.variante?.passageSansControleDeDestination && executable(requete)) {
    return refus("PASSAGE_DESTINATION_EXECUTABLE", requete.destination + " " + url.pathname);
  }
  if (!CONFIG.variante?.passageSansControleDeChemin && cheminSuspect(url.pathname)) {
    return refus("PASSAGE_CHEMIN_SUSPECT", url.pathname);
  }
  let reponse;
  try {
    reponse = await fetch(new Request(requete, { redirect: CONFIG.variante?.passageSuitLesRedirections ? "follow" : "manual" }));
  } catch (erreur) {
    return Response.error(); // réseau coupé : l'échec doit rester un échec RÉSEAU (TypeError côté page)
  }
  if (!CONFIG.variante?.passageSuitLesRedirections && (reponse.type === "opaqueredirect" || (reponse.status >= 300 && reponse.status < 400))) {
    return refus("PASSAGE_REDIRECTION", url.pathname);
  }
  const type = reponse.headers.get("Content-Type") ?? "";
  // Sous /artifacts/ (données) : aucun type exécutable. Passage nommé (v86.wasm…) : application/wasm
  // est LE type attendu, donc seuls les types de document/script sont refusés.
  const interdit = donnees ? TYPES_REFUSES_EN_PASSAGE : /(javascript|ecmascript|html|xml|css)/i;
  if (!CONFIG.variante?.passageSansControleDeType && interdit.test(type)) {
    return refus("PASSAGE_TYPE_EXECUTABLE", type);
  }
  return reponse;
}
function enPassage(chemin) {
  if (CONFIG.variante?.artefactsServisParLeSW) return false;
  return chemin.startsWith("/artifacts/") || CONFIG.passage.some((source) => new RegExp(source).test(chemin));
}

self.addEventListener("fetch", (evenement) => {
  const requete = evenement.request;
  const url = new URL(requete.url);
  if (CONFIG.retrait) return; // le script de retrait n'intercepte rien
  if (url.origin !== self.location.origin) {
    journal.horsOrigine += 1;
    if (CONFIG.variante?.horsOrigineAuReseau) return; // MUTANT : laisse partir la requête
    evenement.respondWith(refus("HORS_ORIGINE", url.origin));
    return;
  }
  const chemin = sansRequete(url);
  if (requete.method === "GET" && Object.prototype.hasOwnProperty.call(CONFIG.liste, chemin)) {
    evenement.respondWith(servir(chemin, CONFIG.liste[chemin]));
    return;
  }
  if (enPassage(chemin)) {
    evenement.respondWith(passer(requete, url));
    return;
  }
  if (CONFIG.variante?.horsListeAuReseau) return; // MUTANT : l'ancienne politique « hors liste → réseau »
  evenement.respondWith(refus("HORS_LISTE", chemin));
});

// ---------------------------------------------------------------------------------------------
// Messages : liste FERMÉE, fenêtre de premier niveau du même client seulement, réponse par le port.
// ---------------------------------------------------------------------------------------------
async function verifierToutes() {
  const cache = await caches.open(NOM_DU_CACHE);
  const manquants = [];
  const alteres = [];
  for (const [chemin, entree] of Object.entries(CONFIG.liste)) {
    if (entree.alias) continue;
    const reponse = await cache.match(new Request(new URL(chemin, self.location.origin)));
    if (!reponse) {
      manquants.push(chemin);
      continue;
    }
    const octets = await reponse.arrayBuffer();
    if (octets.byteLength !== entree.taille || (await sha256(octets)) !== entree.sha256) alteres.push(chemin);
  }
  return { ok: manquants.length === 0 && alteres.length === 0, manquants, alteres };
}
const IDENTITE = {
  version: CONFIG.version,
  sequence: CONFIG.sequence,
  plancher: CONFIG.plancher,
  retrait: Boolean(CONFIG.retrait),
  entrees: Object.keys(CONFIG.liste).length,
};
self.addEventListener("message", (evenement) => {
  if (CONFIG.faute?.muet) return; // faute injectée : un SW qui ne répond plus
  const source = evenement.source;
  const donnees = evenement.data;
  const port = evenement.ports?.[0];
  const valide =
    source !== null &&
    source !== undefined &&
    (CONFIG.variante?.messagesDeTousLesClients || (source.type === "window" && source.frameType === "top-level")) &&
    donnees !== null &&
    typeof donnees === "object" &&
    !Array.isArray(donnees) &&
    Object.keys(donnees).every((cle) => cle === "type" || cle === "id") &&
    (donnees.id === undefined || (typeof donnees.id === "string" && donnees.id.length <= 64)) &&
    ["version", "verifier", "clients", "journal"].includes(donnees.type) &&
    evenement.ports?.length === 1;
  if (!valide) {
    journal.messagesRefuses += 1;
    return; // aucune réponse : un message mal formé ne reçoit rien
  }
  const repondre = (corps) => port.postMessage({ id: donnees.id ?? null, ...corps });
  if (donnees.type === "version") return repondre({ ...IDENTITE });
  if (donnees.type === "journal") return repondre({ journal });
  if (donnees.type === "clients") {
    evenement.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((liste) => repondre({ fenetres: liste.length })),
    );
    return;
  }
  evenement.waitUntil(verifierToutes().then((r) => repondre({ ...IDENTITE, ...r })));
});
