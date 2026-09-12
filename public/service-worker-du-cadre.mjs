// LE SERVICE WORKER DE LA COQUILLE DE CADRE (#192, ADR 0038).
//
// Il vit sur l'ORIGINE APPLICATIVE, et seulement là. L'ADR 0002 le lui accorde nommément — « le
// document applicatif peut enregistrer un Service Worker sur SA portée » —, et l'ADR 0030
// décision 4 le refuse tout aussi nommément sur l'origine de CONFIANCE, où il interposerait du code
// privilégié entre l'hébergeur et la coquille. Les deux décisions ne se contredisent pas : elles
// parlent de deux territoires.
//
// ## Pourquoi il est à la RACINE
//
// La portée maximale d'un Service Worker est le répertoire de son script, sauf en-tête
// `Service-Worker-Allowed` — que ce dépôt refuse délibérément de servir (`tools/serve-headers.mjs`).
// Pour intercepter `/`, `/notes/42` et `/vault.css`, il lui faut donc la racine.
//
// ## Ce qu'il fait
//
// Il DEMANDE à ses clients lesquels détiennent un port restreint, puis laisse `routerLaRequete`
// (`src/coquille/routage-du-cadre.mjs`) décider : le réseau, le courtier de CE client, ou un refus
// lisible. La décision est pure, éprouvée et mutée ; ce fichier-ci ne fait que l'exécuter. La
// propriété qu'elle tient, depuis la revue de sécurité de la PR #203 : **aucune requête n'est servie
// par le courtier d'un autre coffre**, et un onglet ouvert à la main n'est jamais un courtier.
//
// ## Ce qu'il NE fait PAS
//
//  - **il ne CACHE rien.** Aucun `caches.open`, aucun stockage. Les LIAISONS client → courtier
//    vivent en mémoire et meurent avec lui : un Service Worker arrêté par le navigateur les perd, et
//    une sous-ressource sans liaison reçoit alors un refus — jamais le courtier d'un autre ;
//  - **il ne détient aucune clé, aucun cookie, aucun port privilégié**, et n'ouvre aucune voie
//    NOUVELLE vers la coquille : tout passe par le port restreint, sous le contrat de l'ADR 0028.

import {
  CONTRAT_DU_CADRE,
  DELAI_DE_PRESENCE_MS,
  DELAI_DU_COURTIER_MS,
  ENTETES_RELEVEES,
  TYPES_DU_CADRE,
} from "./cadre/contrat-du-cadre.mjs";
import {
  CHEMIN_DU_COURTIER,
  ENTETES_DE_L_HEBERGEUR_APPLICATIF,
  ENTETES_DE_REPONSE_RENDUES,
  estUnCheminDeLaCoquilleDeCadre,
} from "./src/coquille/relais-http.mjs";
import {
  ISSUES_DU_ROUTAGE,
  presencesNecessaires,
  routerLaRequete,
} from "./src/coquille/routage-du-cadre.mjs";

/** Client → courtier, appris à chaque navigation relayée. En mémoire seulement. */
const liaisons = new Map();

self.addEventListener("install", () => {
  // Il prend la main TOUT DE SUITE : un cadre qui attendrait la fermeture de l'onglet pour activer
  // son Service Worker ne servirait jamais sa première page.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Et il réclame les clients DÉJÀ ouverts : le courtier s'est chargé avant lui, par construction.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const donnee = event.data;
  if (donnee?.contrat !== CONTRAT_DU_CADRE.id || donnee?.version !== CONTRAT_DU_CADRE.version)
    return;
  // Réclamer un client ne lui donne rien d'autre que d'être intercepté : c'est ce qui arrive déjà à
  // tout document ouvert après l'activation. Le geste est donc sans capacité, et ouvert à tous.
  if (donnee.type === TYPES_DU_CADRE.reclamer) event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const requete = {
    mode: event.request.mode,
    destination: event.request.destination,
    clientId: event.clientId,
    reserve: estUnCheminDeLaCoquilleDeCadre(url.pathname),
    cheminDuCourtier: url.pathname === CHEMIN_DU_COURTIER,
  };
  // Ce qui n'a besoin de rien savoir des courtiers est décidé sur-le-champ : le chemin de la coquille
  // de cadre elle-même ne doit jamais attendre une question posée… à lui-même.
  if (!presencesNecessaires(requete)) {
    const issue = routerLaRequete({ ...requete, liaisons, presences: [] });
    if (issue.issue === ISSUES_DU_ROUTAGE.reseau) return;
    event.respondWith(executer(issue, event, url));
    return;
  }
  event.respondWith(
    presencesDesCandidats().then((presences) =>
      executer(routerLaRequete({ ...requete, liaisons, presences }), event, url),
    ),
  );
});

/**
 * EXÉCUTE l'issue du routage.
 *
 * @param {{ issue: string, courtier?: string, code?: string }} issue
 * @param {FetchEvent} event
 * @param {URL} url
 */
async function executer(issue, event, url) {
  if (issue.issue === ISSUES_DU_ROUTAGE.reseau) return fetch(event.request);
  if (issue.issue === ISSUES_DU_ROUTAGE.refus) return reponseDeRefus(event.request, issue.code);
  const courtier = await self.clients.get(issue.courtier);
  if (!courtier) return reponseDeRefus(event.request, "CADRE_COURTIER_DISPARU");
  // La LIAISON est apprise à la navigation, quelle qu'en soit l'issue : le client qui en naît
  // appartient à ce coffre-ci, et à nul autre.
  if (event.request.mode === "navigate" && event.resultingClientId) {
    liaisons.set(event.resultingClientId, courtier.id);
  }
  return servirParLeCourtier(courtier, event.request, url);
}

/**
 * Les CANDIDATS au rôle de courtier, et ce que chacun a répondu.
 *
 * Un candidat est un client fenêtre ouvert sur le chemin du courtier ; il n'est un COURTIER que
 * s'il dit détenir un port restreint (revue de sécurité de la PR #203, constat 2). La question est
 * posée à chaque fois : un document peut recevoir son port après avoir répondu « non », et une
 * réponse gardée en mémoire le ferait ignorer au profit d'un autre.
 *
 * `includeUncontrolled` est indispensable : le courtier s'est chargé AVANT que ce Service Worker
 * n'existe — c'est lui qui l'a enregistré.
 *
 * @returns {Promise<import("./src/coquille/routage-du-cadre.mjs").Presence[]>}
 */
async function presencesDesCandidats() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const candidats = clients.filter((client) => new URL(client.url).pathname === CHEMIN_DU_COURTIER);
  const vivants = new Set(clients.map((client) => client.id));
  for (const client of liaisons.keys()) if (!vivants.has(client)) liaisons.delete(client);
  return Promise.all(
    candidats.map(async (client) => ({ id: client.id, porte: await demanderLaPresence(client) })),
  );
}

/** « Détiens-tu un port restreint ? » — `true`, `false`, ou `null` sans réponse à temps. */
function demanderLaPresence(client) {
  return new Promise((rendre) => {
    const canal = new MessageChannel();
    const minuterie = setTimeout(() => {
      canal.port1.close();
      rendre(null);
    }, DELAI_DE_PRESENCE_MS);
    canal.port1.onmessage = (message) => {
      clearTimeout(minuterie);
      canal.port1.close();
      const reponse = message.data;
      rendre(reponse?.type === TYPES_DU_CADRE.presenceReponse ? reponse.porte === true : null);
    };
    client.postMessage(enveloppeDuCadre(TYPES_DU_CADRE.presence), [canal.port2]);
  });
}

function enveloppeDuCadre(type, champs = {}) {
  return { contrat: CONTRAT_DU_CADRE.id, version: CONTRAT_DU_CADRE.version, type, ...champs };
}

/**
 * SERT une requête en la faisant relayer par LE courtier désigné.
 *
 * @param {Client} courtier
 * @param {Request} requete
 * @param {URL} url
 */
async function servirParLeCourtier(courtier, requete, url) {
  const corps = await lireLeCorps(requete);
  if (corps === ILLISIBLE) return reponseDeRefus(requete, "CADRE_CORPS_ILLISIBLE");
  const demande = enveloppeDuCadre(TYPES_DU_CADRE.demande, {
    methode: requete.method,
    chemin: `${url.pathname}${url.search}`,
    entetes: entetesRelevees(requete.headers),
    corps,
  });
  const rendue = await demanderAuCourtier(courtier, demande);
  if (rendue.type === TYPES_DU_CADRE.attente) return reponseDAttente(requete, rendue);
  if (rendue.type !== TYPES_DU_CADRE.reponse) return reponseDeRefus(requete, rendue.code);
  // Une réponse que le navigateur refuserait de construire — un en-tête illisible, un statut hors
  // plage — rend un refus NOMMÉ, jamais la page d'échec du navigateur (revue de sécurité #203, 11).
  try {
    return reponseServie(rendue);
  } catch {
    return reponseDeRefus(requete, "CADRE_REPONSE_ILLISIBLE");
  }
}

/** Un aller-retour avec le courtier, sur un `MessageChannel` NEUF par requête. */
function demanderAuCourtier(courtier, demande) {
  return new Promise((rendre) => {
    const canal = new MessageChannel();
    const minuterie = setTimeout(() => {
      canal.port1.close();
      rendre({ type: TYPES_DU_CADRE.refus, code: "CADRE_COURTIER_MUET" });
    }, DELAI_DU_COURTIER_MS);
    canal.port1.onmessage = (message) => {
      clearTimeout(minuterie);
      canal.port1.close();
      rendre(message.data ?? { type: TYPES_DU_CADRE.refus, code: "CADRE_REPONSE_VIDE" });
    };
    courtier.postMessage(demande, [canal.port2]);
  });
}

/**
 * Les en-têtes de POLITIQUE de l'hébergeur, rejoués sur tout ce que ce Service Worker fabrique :
 * sans eux, une réponse synthétisée ne porte ni `nosniff`, ni CORP, ni `Cache-Control` (revue de
 * sécurité de la PR #203, constat 7). Ils sont posés APRÈS ceux du guest, et gagnent donc sur eux.
 */
function avecLesEntetesDeLHebergeur(entetes) {
  for (const [nom, valeur] of Object.entries(ENTETES_DE_L_HEBERGEUR_APPLICATIF)) {
    entetes.set(nom, valeur);
  }
  return entetes;
}

/** Ce que la réponse relayée devient pour le navigateur. */
function reponseServie(rendue) {
  const entetes = new Headers();
  for (const nom of ENTETES_DE_REPONSE_RENDUES) {
    const valeur = rendue.entetes?.[nom];
    if (typeof valeur === "string") entetes.set(nom, valeur);
  }
  avecLesEntetesDeLHebergeur(entetes);
  const statut = rendue.statut;
  // Une REDIRECTION est rendue au navigateur, qui la suit lui-même et met à jour l'URL du cadre.
  const emplacement = entetes.get("location");
  if (emplacement !== null && REDIRECTIONS.has(statut)) {
    const cible = new URL(emplacement, self.location.origin);
    // Seconde ligne de défense du constat 4 : une cible résolue HORS de cette origine n'est pas
    // suivie, quoi que la garde du relais ait laissé passer.
    if (cible.origin !== self.location.origin) throw new Error("redirection hors de l'origine");
    // `Response.redirect` : la seule redirection que les trois moteurs suivent depuis un Service
    // Worker. Ses en-têtes sont figés, et elle ne porte aucun corps que `nosniff` protégerait.
    return Response.redirect(cible.href, statut);
  }
  const corps = SANS_CORPS.has(statut) ? null : octetsDepuisBase64(rendue.corps ?? "");
  return new Response(corps, { status: statut, headers: entetes });
}

/** Les statuts de redirection que le navigateur suit. */
const REDIRECTIONS = new Set([301, 302, 303, 307, 308]);

/** Les statuts dont le constructeur de `Response` refuse un corps, fût-il vide. */
const SANS_CORPS = new Set([101, 204, 205, 304]);

/**
 * Ce qu'un REFUS devient : une page qui NOMME sa cause.
 *
 * Une navigation reçoit une page HTML lisible avec un geste pour réessayer ; une sous-ressource, un
 * texte brut. Jamais une page blanche, jamais un repli vers le réseau : un repli servirait le 404
 * du serveur statique, et l'utilisateur lirait « page introuvable » là où il fallait lire la cause.
 * Le code est public par construction (ADR 0028).
 */
function reponseDeRefus(requete, codeRecu) {
  const code = typeof codeRecu === "string" ? codeRecu : "CADRE_REFUS_SANS_CODE";
  if (requete.mode !== "navigate") {
    return new Response(`Le relais de la coquille a refusé cette requête : ${code}\n`, {
      status: 504,
      headers: avecLesEntetesDeLHebergeur(
        new Headers({ "content-type": "text/plain; charset=utf-8" }),
      ),
    });
  }
  return pageHonnete({
    statut: 504,
    etat: "refus",
    titre: "Cette page n'a pas pu être servie",
    phrase: `Le relais du coffre a refusé la requête. Code : ${code}.`,
    code,
  });
}

/**
 * La page d'ATTENTE : l'application n'est pas encore démarrée (revue d'intégration #203, I1).
 *
 * Le courtier ne relaie RIEN tant qu'elle ne l'est pas, et il redemande lui-même la page à l'instant
 * où elle démarre. Cette page dit ce qui se passe, depuis combien de temps, et offre un geste.
 */
function reponseDAttente(requete, rendue) {
  const depuis = Number.isFinite(rendue.depuisMs)
    ? Math.max(0, Math.round(rendue.depuisMs / 1000))
    : 0;
  if (requete.mode !== "navigate") {
    return new Response("L'application du coffre n'est pas encore démarrée.\n", {
      status: 503,
      headers: avecLesEntetesDeLHebergeur(
        new Headers({ "content-type": "text/plain; charset=utf-8" }),
      ),
    });
  }
  return pageHonnete({
    statut: 503,
    etat: "attente",
    titre: "Le coffre démarre",
    phrase: `L'application n'est pas encore démarrée (${depuis} s d'attente). Cette page se remplacera d'elle-même dès qu'elle le sera.`,
    code: "CADRE_APPLICATION_EN_ATTENTE",
  });
}

/** Une page courte, sans script, qui dit son état dans un attribut lisible par une épreuve. */
function pageHonnete({ statut, etat, titre, phrase, code }) {
  const html = `<!doctype html>
<html lang="fr" data-cadre="${etat}" data-cadre-code="${echapper(code)}">
<head><meta charset="utf-8"><title>${echapper(titre)}</title></head>
<body>
<main>
<h1>${echapper(titre)}</h1>
<p role="status">${echapper(phrase)}</p>
<p><a href="">Réessayer</a></p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: statut,
    headers: avecLesEntetesDeLHebergeur(
      new Headers({ "content-type": "text/html; charset=utf-8" }),
    ),
  });
}

function echapper(texte) {
  return String(texte).replace(/[&<>"']/g, (signe) => `&#${signe.charCodeAt(0)};`);
}

/** Marqueur d'un corps que ce moteur n'a pas laissé lire. Distinct de `null`, qui dit « aucun ». */
const ILLISIBLE = Symbol("corps-illisible");

/** LIT le corps d'une requête interceptée, ou dit qu'il n'a pas pu. */
async function lireLeCorps(requete) {
  if (requete.method === "GET" || requete.method === "HEAD") return null;
  try {
    return base64Depuis(new Uint8Array(await requete.arrayBuffer()));
  } catch {
    return ILLISIBLE;
  }
}

/** Les trois en-têtes relevés de la requête interceptée, et rien d'autre. */
function entetesRelevees(entetes) {
  const releves = {};
  for (const nom of ENTETES_RELEVEES) {
    const valeur = entetes.get(nom);
    if (valeur !== null) releves[nom] = valeur;
  }
  return releves;
}

function base64Depuis(octets) {
  let binaire = "";
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return btoa(binaire);
}

function octetsDepuisBase64(texte) {
  const binaire = atob(texte);
  const octets = new Uint8Array(binaire.length);
  for (let index = 0; index < binaire.length; index += 1) octets[index] = binaire.charCodeAt(index);
  return octets;
}
