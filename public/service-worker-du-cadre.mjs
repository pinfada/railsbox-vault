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
// Pour intercepter `/`, `/notes/42` et `/vault.css`, il lui faut donc la racine. Ce n'est pas un
// choix de rangement : c'est la seule position que la règle de portée autorise, et la refuser
// reviendrait à demander au serveur une complaisance que le spike #35 mesure précisément pour ne
// pas la demander.
//
// ## Ce qu'il fait, et l'ordre dans lequel il le fait
//
//  1. une requête vers une AUTRE origine : il ne s'en mêle pas ;
//  2. une requête vers un chemin de la COQUILLE DE CADRE — le document courtier, ses modules, les
//     bancs — : il ne s'en mêle pas non plus. Sans cette liste, il relaierait au guest le document
//     qui le porte, c'est-à-dire qu'il scierait la branche sur laquelle il est assis ;
//  3. tout le reste : il demande au COURTIER de relayer. Le courtier est le document encadré par la
//     coquille, seul détenteur du port restreint ;
//  4. **aucun courtier joignable : il laisse passer au réseau.** C'est la règle qui le rend INERTE
//     hors de la coquille. Un onglet ouvert à la main sur l'origine applicative ne subit rien ; une
//     suite de navigateur qui sert ses fixtures sur la même origine ne voit rien changer.
//
// ## Ce qu'il NE fait PAS, et qui est aussi important
//
//  - **il ne CACHE rien.** Aucun `caches.open`, aucun stockage, aucune persistance. Il ne retient
//    donc rien d'une session de coffre après son verrouillage — pas parce qu'on l'efface, mais parce
//    que rien n'a été écrit. C'est la propriété du bocal à cookies, appliquée à l'autre bout ;
//  - **il ne détient aucune clé, aucun cookie, aucun port privilégié.** Il ne connaît même pas
//    l'origine de la coquille : il parle à un client de SA propre origine, et c'est ce client qui
//    détient le seul canal vers elle ;
//  - **il n'ouvre aucune voie NOUVELLE vers la coquille.** Tout ce qu'il obtient passe par le port
//    restreint, sous le contrat strict de l'ADR 0028, avec ses dix refus inchangés. Le supprimer
//    n'enlèverait rien à la frontière ; l'ajouter ne lui ajoute rien non plus.

import {
  CHEMIN_DU_COURTIER,
  CONTRAT_DU_CADRE,
  DELAI_DU_COURTIER_MS,
  ENTETES_RELEVEES,
  TYPES_DU_CADRE,
} from "./cadre/contrat-du-cadre.mjs";
import {
  ENTETES_DE_REPONSE_RENDUES,
  estUnCheminDeLaCoquilleDeCadre,
} from "./src/coquille/relais-http.mjs";

self.addEventListener("install", () => {
  // Il prend la main TOUT DE SUITE : un cadre qui attendrait la fermeture de l'onglet pour activer
  // son Service Worker ne servirait jamais sa première page, et l'utilisateur verrait un 404 là où
  // il a demandé son application.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Et il réclame les clients DÉJÀ ouverts : le document courtier s'est chargé avant lui, par
  // construction — c'est lui qui l'enregistre.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (estUnCheminDeLaCoquilleDeCadre(url.pathname)) return;
  event.respondWith(servirParLeCourtier(event.request, url));
});

/**
 * SERT une requête en la faisant relayer par le courtier.
 *
 * @param {Request} requete
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function servirParLeCourtier(requete, url) {
  const courtier = await trouverLeCourtier();
  // AUCUN courtier : le Service Worker s'efface. C'est ce qui le rend inoffensif partout où la
  // coquille n'est pas, et ce qui fait qu'il n'a rien à désinstaller au verrouillage.
  if (courtier === null) return fetch(requete);

  const corps = await lireLeCorps(requete);
  // Un corps ILLISIBLE rend un 504 qui le nomme, et non une erreur de réseau. La différence compte :
  // une erreur de réseau affiche la page d'échec du navigateur, où l'on ne peut rien lire de ce qui
  // s'est passé ; un 504 dit lequel des deux côtés a renoncé.
  if (corps === ILLISIBLE) return reponseDeRefus({ code: "CADRE_CORPS_ILLISIBLE" });

  const demande = {
    contrat: CONTRAT_DU_CADRE.id,
    version: CONTRAT_DU_CADRE.version,
    type: TYPES_DU_CADRE.demande,
    methode: requete.method,
    chemin: `${url.pathname}${url.search}`,
    entetes: entetesRelevees(requete.headers),
    corps,
  };

  const rendue = await demanderAuCourtier(courtier, demande);
  if (rendue.type === TYPES_DU_CADRE.refus) return reponseDeRefus(rendue);
  return reponseServie(rendue);
}

/**
 * Le COURTIER parmi les clients de cette origine, ou `null`.
 *
 * `includeUncontrolled` est indispensable : le courtier s'est chargé AVANT que ce Service Worker
 * n'existe — c'est lui qui l'a enregistré —, et sans ce drapeau il resterait invisible jusqu'à un
 * rechargement que personne ne déclencherait.
 */
async function trouverLeCourtier() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    if (new URL(client.url).pathname === CHEMIN_DU_COURTIER) return client;
  }
  return null;
}

/**
 * Un aller-retour avec le courtier, sur un `MessageChannel` NEUF par requête.
 *
 * Un canal par requête plutôt qu'un canal partagé avec des corrélations : ici, contrairement au port
 * restreint, il n'y a pas de frontière à tenir, et un canal jetable apparie les réponses aux
 * requêtes sans qu'aucun identifiant n'ait à être inventé, borné ni vérifié. Ce qui n'existe pas ne
 * se confond pas.
 */
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

/** Ce que la réponse relayée devient pour le navigateur. */
function reponseServie(rendue) {
  const entetes = new Headers();
  for (const nom of ENTETES_DE_REPONSE_RENDUES) {
    const valeur = rendue.entetes?.[nom];
    if (typeof valeur === "string") entetes.set(nom, valeur);
  }
  const statut = rendue.statut;
  // Une REDIRECTION est rendue au navigateur, qui la suit lui-même et met à jour l'URL du cadre.
  // La suivre ici rendrait la bonne page sous la mauvaise adresse : un lien relatif de la page
  // d'arrivée se résoudrait alors contre le chemin du formulaire.
  const emplacement = entetes.get("location");
  if (emplacement !== null && REDIRECTIONS.has(statut)) {
    return Response.redirect(new URL(emplacement, self.location.origin), statut);
  }
  const corps = SANS_CORPS.has(statut) ? null : octetsDepuisBase64(rendue.corps ?? "");
  return new Response(corps, { status: statut, headers: entetes });
}

/** Les statuts que `Response.redirect` accepte, et les seuls que le navigateur suit. */
const REDIRECTIONS = new Set([301, 302, 303, 307, 308]);

/** Les statuts dont le constructeur de `Response` refuse un corps, fût-il vide. */
const SANS_CORPS = new Set([101, 204, 205, 304]);

/**
 * Ce qu'un REFUS devient : un 504 qui NOMME sa cause, en texte brut.
 *
 * Jamais une page blanche, jamais un `fetch` de repli vers le réseau : un repli servirait le 404 du
 * serveur statique, et l'utilisateur lirait « page introuvable » là où il fallait lire « le coffre
 * est verrouillé ». Le code est rendu tel quel — c'est un code de la coquille, public par
 * construction (ADR 0028 : « un adversaire qui lit ce code apprend ce qu'il a demandé »).
 */
function reponseDeRefus(rendue) {
  const code = typeof rendue.code === "string" ? rendue.code : "CADRE_REFUS_SANS_CODE";
  return new Response(`Le relais de la coquille a refusé cette requête : ${code}\n`, {
    status: 504,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Marqueur d'un corps que ce moteur n'a pas laissé lire. Distinct de `null`, qui dit « aucun ». */
const ILLISIBLE = Symbol("corps-illisible");

/**
 * LIT le corps d'une requête interceptée, ou dit qu'il n'a pas pu.
 *
 * Un `GET` et un `HEAD` n'en portent pas, et le demander serait inutile. Pour le reste — une
 * soumission de formulaire, notamment —, la lecture est GARDÉE : ce qu'un moteur laisse lire du
 * corps d'une requête de NAVIGATION n'est pas écrit pareil partout, et un échec silencieux ici
 * rendrait une page d'erreur du navigateur au lieu d'un refus qui se lit.
 */
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

/** Base64 sans dépendance : ce Worker ne charge rien de la coquille au-delà de deux constantes. */
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
