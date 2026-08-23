// Contrat partagé du spike #35 : topologies comparées, origines attendues et règles d'admission
// des messages reçus par la coquille. Ce module est chargé tel quel par la coquille dans le
// navigateur, par le serveur de test et par la suite unitaire Node : les trois raisonnent donc sur
// la même table plutôt que sur trois copies divergentes.

export const SHELL_HOST = "127.0.0.1";
export const SHELL_PORT = 4173;
export const APP_HOST = "localhost";
export const APP_PORT = 4174;

export const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`;
export const APP_ORIGIN = `http://${APP_HOST}:${APP_PORT}`;

// `127.0.0.1` et `localhost` désignent la même interface de bouclage mais forment deux origines
// distinctes au sens du navigateur, et toutes deux sont des contextes sécurisés. Le spike obtient
// ainsi une vraie frontière d'origine sans DNS, sans certificat et sans second hébergeur.

export const SHELL_PATH = "/spike/origin/shell.html";
export const APP_PATH = "/spike/origin/app.html";
export const CANARY_PATH = "/spike/origin/canary.txt";
export const CANARY_AUTHENTIC = "canary-authentique";
export const CANARY_INTERCEPTED = "canary-intercepte";

/** Préfixe des ressources considérées comme territoire applicatif, donc servies sans CSP. */
export const APPLICATION_TERRITORY_PREFIX = "/spike/origin/app";

/**
 * Les quatre topologies mesurées. `appHost` dit quel serveur sert le document applicatif ;
 * `sandbox` est l'attribut posé sur l'iframe, `null` signifiant « aucun attribut sandbox ».
 */
export const ORIGIN_TOPOLOGIES = Object.freeze({
  "T1a-meme-origine-sans-sandbox": Object.freeze({
    appHost: "shell",
    sandbox: null,
    resume: "l'application partage l'origine de la coquille et son autorité complète",
  }),
  "T1b-meme-origine-sandbox-opaque": Object.freeze({
    appHost: "shell",
    sandbox: "allow-scripts",
    resume: "l'application est servie par l'origine de la coquille mais reçoit une origine opaque",
  }),
  "T2-origine-distincte-sandbox": Object.freeze({
    appHost: "app",
    sandbox: "allow-scripts allow-same-origin",
    resume: "l'application vit sur une autre origine et conserve son propre stockage",
  }),
  "T3-origine-distincte-opaque": Object.freeze({
    appHost: "app",
    sandbox: "allow-scripts",
    resume: "l'application vit sur une autre origine et reçoit en plus une origine opaque",
  }),
});

export const TOPOLOGY_IDS = Object.freeze(Object.keys(ORIGIN_TOPOLOGIES));

/** Origine opaque telle que le navigateur la sérialise dans `event.origin`. */
export const OPAQUE_ORIGIN = "null";

/**
 * @param {string} id
 * @returns {{ appHost: "shell" | "app", sandbox: string | null, resume: string }}
 */
export function topologyOf(id) {
  const topology = ORIGIN_TOPOLOGIES[id];
  if (!topology) {
    throw new Error(`Topologie inconnue : ${id}. Valeurs admises : ${TOPOLOGY_IDS.join(", ")}.`);
  }
  return topology;
}

/** Une sandbox sans `allow-same-origin` prive le document de son origine : elle devient opaque. */
export function grantsSameOrigin(sandbox) {
  return sandbox === null || sandbox.split(/\s+/).includes("allow-same-origin");
}

/**
 * Origine que la coquille doit exiger dans `event.origin` pour cette topologie.
 * @returns {string} une origine sérialisée, ou `"null"` pour une origine opaque.
 */
export function expectedAppOrigin(id) {
  const topology = topologyOf(id);
  if (!grantsSameOrigin(topology.sandbox)) return OPAQUE_ORIGIN;
  return topology.appHost === "app" ? APP_ORIGIN : SHELL_ORIGIN;
}

/**
 * `targetOrigin` utilisable pour transférer le port applicatif. Une origine opaque n'est pas
 * adressable : le transfert doit alors être diffusé avec `"*"`, ce qui est un coût mesurable de
 * ces topologies et non un détail d'implémentation.
 */
export function channelTargetOrigin(id) {
  return expectedAppOrigin(id) === OPAQUE_ORIGIN ? "*" : expectedAppOrigin(id);
}

/** URL du document applicatif pour cette topologie. */
export function appDocumentUrl(id, { isolation = null } = {}) {
  const topology = topologyOf(id);
  const base = topology.appHost === "app" ? APP_ORIGIN : SHELL_ORIGIN;
  const url = new URL(APP_PATH, base);
  if (isolation) url.searchParams.set("isolation", isolation);
  return url.toString();
}

// --- Contrat de messages ---------------------------------------------------------------------

export const MESSAGE_TYPES = Object.freeze({
  /** Seul message que la coquille accepte sur `window` : l'annonce du document applicatif. */
  appHello: "vault.app-hello",
  /** Réponse de la coquille, porteuse du port restreint. */
  channelGrant: "vault.channel-grant",
  /** Seule requête admise sur le port restreint. */
  statusRequest: "vault.status",
  statusReply: "vault.status-reply",
  refusal: "vault.refus",
});

/** Requêtes que la coquille accepte sur le port restreint. Tout le reste est refusé et journalisé. */
export function isAllowedAppRequest(type) {
  return type === MESSAGE_TYPES.statusRequest;
}

/**
 * Décide si une annonce reçue sur `window` peut donner lieu à l'émission du port restreint.
 *
 * Trois conditions indépendantes, chacune nécessaire :
 *  - le type attendu, qui ne prouve rien à lui seul puisque n'importe quel document le connaît ;
 *  - l'origine attendue, qui distingue les topologies inter-origines ;
 *  - l'identité de la fenêtre émettrice, seule à distinguer l'iframe applicative d'une iframe
 *    imbriquée qu'elle aurait créée, laquelle porte la même origine.
 * L'unicité ferme enfin la porte d'un second port réclamé après coup.
 *
 * @param {{ type: unknown, origin: string, sourceIsAppFrame: boolean,
 *           expectedOrigin: string, alreadyGranted: boolean }} candidate
 * @returns {{ accepted: boolean, reason: string }}
 */
export function evaluateAppHello(candidate) {
  const { type, origin, sourceIsAppFrame, expectedOrigin, alreadyGranted } = candidate;
  if (type !== MESSAGE_TYPES.appHello) return { accepted: false, reason: "type-inattendu" };
  if (origin !== expectedOrigin) return { accepted: false, reason: "origine-inattendue" };
  if (!sourceIsAppFrame) return { accepted: false, reason: "fenetre-emettrice-inattendue" };
  if (alreadyGranted) return { accepted: false, reason: "port-deja-emis" };
  return { accepted: true, reason: "admis" };
}
