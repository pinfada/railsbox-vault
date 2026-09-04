// Options de ligne de commande et en-têtes de sécurité du serveur de test. Extrait de
// `serve.mjs` pour être vérifiable sous Node sans démarrer de socket : la CSP de la coquille et
// la frontière « territoire applicatif » sont des règles de sécurité, pas de la plomberie HTTP.

import {
  APPLICATION_TERRITORY_PREFIX,
  APP_HOST,
  APP_ORIGIN,
  APP_PORT,
  SHELL_HOST,
  SHELL_PORT,
} from "../src/spike/origin-topology.mjs";

export const SERVER_ROLES = Object.freeze(["shell", "app"]);

/** Valeur attendue de `?isolation=` pour obtenir COOP/COEP sur une réponse. */
export const ISOLATION_REQUIRE_CORP = "require-corp";

/**
 * Variable d'environnement par laquelle le harnais de mesure #52 se déclare, et jeton attendu.
 *
 * `--worker-src-blob` ÉLARGIT une frontière de sécurité. L'ADR 0013 et `SECURITY.md` affirment
 * qu'aucun lancement de service ne le pose : cette paire fait de cette phrase une garantie du code
 * plutôt qu'une convention de relecture. Un `npm start -- --worker-src-blob` échoue au démarrage,
 * bruyamment, au lieu de servir la politique élargie en silence.
 */
export const HARNAIS_CSP_ENV = "VAULT_HARNAIS_CSP";
export const HARNAIS_CSP_VALEUR = "mesure-worker-src";

/**
 * CSP de la coquille de confiance. `default-src 'none'` impose de nommer chaque capacité ;
 * `frame-src` n'autorise que l'origine applicative déclarée, ce qui rend observable toute
 * tentative d'encadrer un document tiers.
 *
 * `'wasm-unsafe-eval'` est ajouté depuis le spike #4 : le runtime v86 instancie un module
 * WebAssembly, et sous `script-src 'self'` seul, `WebAssembly.instantiate` est refusé par les TROIS
 * moteurs de la matrice — le spike #4 ne l'avait mesuré que sous Chromium, l'ADR 0013 l'a mesuré
 * partout et `tests/browser/csp-frontiere.spec.mjs` le rejoue à chaque `npm run check`. C'est le
 * jeton le plus étroit qui autorise WebAssembly — il n'ouvre ni `eval` ni `new Function`, à la
 * différence de `'unsafe-eval'`. Voir l'ADR 0003.
 *
 * `worker-src` reste `'self'` : l'ADR 0013 refuse d'y ajouter `blob:`. Le seul consommateur qui
 * l'exigerait est la boucle d'ordonnancement de secours de v86, dont aucun moteur capable de porter
 * le produit n'a besoin. `workerSrcBlob` n'est PAS une option de service : c'est l'instrument de
 * mesure qui rend cette décision falsifiable, réservé au harnais `npm run test:csp`. Aucun chemin
 * de production ne la pose, et `tests/browser/csp-frontiere.spec.mjs` vérifie que la politique
 * servie par défaut ne contient jamais `blob:`.
 *
 * @param {string} appOrigin
 * @param {{ workerSrcBlob?: boolean }} [variante]
 */
export function shellContentSecurityPolicy(appOrigin, { workerSrcBlob = false } = {}) {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    workerSrcBlob ? "worker-src 'self' blob:" : "worker-src 'self'",
    `frame-src 'self' ${appOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Le document applicatif et ses scripts sont servis SANS CSP, dans toutes les topologies.
 *
 * En production le HTML applicatif est produit par le guest et relayé par le proxy : lui imposer
 * ici une CSP reviendrait à mesurer notre propre politique au lieu de la frontière d'origine. Le
 * durcissement par CSP injectée reste une piste, il est discuté dans l'ADR 0002.
 */
export function isApplicationTerritory(pathname) {
  return pathname.startsWith(APPLICATION_TERRITORY_PREFIX);
}

/** Préfixe de la sonde de capacités #2, exemptée pour la raison expliquée ci-dessous. */
export const CAPABILITY_PROBE_PREFIX = "/compat";

/**
 * La sonde de capacités mesure ce que le moteur sait faire — instancier un module WebAssembly,
 * notamment. Une CSP qui le lui refuserait ferait rendre « capacité absente » à un navigateur qui
 * la possède : la sonde mesurerait notre politique et non le moteur. Elle est donc exemptée, et
 * elle n'est pas un document de coquille.
 */
export function isCapabilityProbe(pathname) {
  return pathname.startsWith(CAPABILITY_PROBE_PREFIX);
}

/**
 * Un document de la COQUILLE elle-même : ni territoire applicatif, ni sonde de capacités.
 *
 * Les deux exemptions existaient déjà pour la CSP, chacune avec sa raison, et ces raisons valent
 * mot pour mot pour les politiques ajoutées par l'ADR 0022 — l'une gouverne ce que le document
 * ÉMET, l'autre ce qu'il PEUT, donc toutes deux son contenu. Les nommer une fois évite qu'une
 * troisième politique soit posée demain sur le territoire du guest par simple oubli de la condition.
 */
export function isShellDocument(pathname) {
  return !isApplicationTerritory(pathname) && !isCapabilityProbe(pathname);
}

/**
 * Préfixe de l'ÉPINGLAGE v86 de l'ADR 0003 : les octets épinglés par empreinte, le manifeste qui
 * les épingle, et les licences du code redistribué. Le sous-arbre entier ne change QU'ENSEMBLE, à
 * la montée de version de l'émulateur — c'est ce qui en fait une seule nature d'artefact, et c'est
 * pourquoi le manifeste vieillit avec les octets qu'il décrit plutôt que devant eux.
 */
export const PREFIXE_EPINGLAGE_V86 = "/vendor/v86/";

/**
 * Fenêtre de fraîcheur de l'épinglage v86, en secondes.
 *
 * 86 400 n'est pas un chiffre de confort : c'est la borne que la plate-forme s'impose déjà au SCRIPT
 * d'un Service Worker, dont l'algorithme de mise à jour ignore le cache au-delà de vingt-quatre
 * heures. C'est donc la plus longue péremption que le navigateur tolère pour le code qui gouvernera
 * le mode hors ligne de l'ADR 0002 ; aligner dessus les artefacts les plus lourds garde une seule
 * fenêtre pour tout l'arbre. (Fait de plate-forme cité de la spécification, non mesuré par ce
 * dépôt — voir l'ADR 0023, « Ce que cette décision ne prouve pas ».)
 */
export const DUREE_EPINGLAGE_V86_SECONDES = 86400;

/** @param {string} pathname */
export function estEpinglageV86(pathname) {
  return pathname.startsWith(PREFIXE_EPINGLAGE_V86);
}

/**
 * Les trois NATURES D'ARTEFACT que l'ADR 0023 distingue. Ce ne sont pas des origines : le territoire
 * applicatif reste le territoire du guest même servi par le rôle `shell`, comme le fait le banc du
 * spike #35.
 */
export const NATURES_DARTEFACT = Object.freeze({
  coquille: "coquille",
  epinglageV86: "epinglage-v86",
  territoireApplicatif: "territoire-applicatif",
});

/**
 * Politique de cache de chaque nature (ADR 0023). Les motifs sont dans l'ADR ; en une ligne chacun :
 *
 * - `coquille` — elle change à chaque version, et son URL ne nomme pas sa version : elle doit être
 *   REVALIDÉE avant réemploi. `no-cache` autorise le stockage, il n'autorise pas le réemploi muet ;
 * - `epinglage-v86` — 2,4 Mio d'octets qui ne changent qu'à la montée de version de l'émulateur.
 *   PAS d'`immutable` : l'ADR 0003 épingle par empreinte dans le manifeste, pas dans l'URL, et
 *   `immutable` interdirait au navigateur de jamais s'apercevoir d'un ré-épinglage ;
 * - `territoire-applicatif` — ce que cette origine sert en production porte les cookies de session
 *   Rails. `no-store` y est désormais une DÉCISION et non plus un héritage.
 */
export const POLITIQUES_DE_CACHE = Object.freeze({
  [NATURES_DARTEFACT.coquille]: "no-cache",
  [NATURES_DARTEFACT.epinglageV86]: `public, max-age=${DUREE_EPINGLAGE_V86_SECONDES}`,
  [NATURES_DARTEFACT.territoireApplicatif]: "no-store",
});

/** @param {{ role: string, pathname: string }} requete */
export function natureDArtefact({ role, pathname }) {
  if (role === "app" || isApplicationTerritory(pathname)) {
    return NATURES_DARTEFACT.territoireApplicatif;
  }
  if (estEpinglageV86(pathname)) return NATURES_DARTEFACT.epinglageV86;
  return NATURES_DARTEFACT.coquille;
}

/** @param {{ role: string, pathname: string }} requete */
export function politiqueDeCache(requete) {
  return POLITIQUES_DE_CACHE[natureDArtefact(requete)];
}

/**
 * Capacités que la coquille refuse EXPLICITEMENT (#104, ADR 0022).
 *
 * La liste est courte, et c'est délibéré. Le risque de cet en-tête n'est pas d'en refuser trop peu,
 * c'est d'en refuser trop : `Permissions-Policy` gouverne aussi les documents ENCADRÉS, et un refus
 * en bloc (`*=()`, ou une liste recopiée d'un guide) fermerait des capacités que ce dépôt n'a
 * jamais mesurées — plein écran de la console VM, presse-papiers vers le guest, sortie audio de
 * v86. Ces trois-là sont refusées parce qu'aucune ligne du produit, du serveur de test ni des bancs
 * ne les appelle : la coquille courtise le déverrouillage et le consentement, elle ne capte rien.
 */
const CAPACITES_REFUSEES_PAR_LA_COQUILLE = Object.freeze(["camera", "microphone", "geolocation"]);

/** `<capacité>=()` est la liste d'autorisation VIDE : personne, pas même `self`. */
function shellPermissionsPolicy() {
  return CAPACITES_REFUSEES_PAR_LA_COQUILLE.map((capacite) => `${capacite}=()`).join(", ");
}

/**
 * @param {{ role: string, pathname: string, isolation: string | null, appOrigin: string,
 *           requestOrigin?: string | null, workerSrcBlob?: boolean }} request
 * @returns {Record<string, string>}
 */
export function securityHeaders({
  role,
  pathname,
  isolation,
  appOrigin,
  requestOrigin = null,
  workerSrcBlob = false,
}) {
  if (!SERVER_ROLES.includes(role)) {
    throw new Error(`Rôle de serveur inconnu : ${role}.`);
  }

  const headers = {
    // SEUL en-tête de ce module dont la valeur dépend du CHEMIN et non du seul rôle (ADR 0023).
    // La publication en tire plusieurs blocs de `_headers`, et son cliquet refuse qu'une SECONDE
    // dimension se mette à varier : voir `cheminsHorsUniformite` dans `tools/publier-en-tetes.mjs`.
    "Cache-Control": politiqueDeCache({ role, pathname }),
    "X-Content-Type-Options": "nosniff",
    // CORP gouverne les récupérations de SOUS-RESSOURCES en mode `no-cors` : il empêche une autre
    // origine de charger les ressources de la coquille, et laisse celles du territoire applicatif
    // chargeables. Il ne gouverne PAS l'encadrement d'un document — ce que la coquille doit à
    // `frame-ancestors 'none'` dans sa CSP. Le commentaire précédent attribuait la non-encadrabilité
    // à CORP ; l'ADR 0010 (§ « Ce qui reste servi ») a relevé l'erreur, corrigée ici.
    "Cross-Origin-Resource-Policy": role === "app" ? "cross-origin" : "same-origin",
  };

  if (role === "shell" && isShellDocument(pathname)) {
    headers["Content-Security-Policy"] = shellContentSecurityPolicy(appOrigin, { workerSrcBlob });
    // La seule requête inter-origine que la CSP ci-dessus laisse sortir est le CADRE du territoire
    // applicatif : `connect-src 'self'` et `img-src 'self'` ferment les autres. Sous la politique
    // par défaut des moteurs, cette requête porte l'origine de la coquille jusqu'à une origine dont
    // le contenu vient du guest (ADR 0002). `no-referrer` la retire, et
    // `tests/browser/entetes-durcissement.spec.mjs` le relève avec son témoin négatif. ADR 0022.
    headers["Referrer-Policy"] = "no-referrer";
    headers["Permissions-Policy"] = shellPermissionsPolicy();
  }

  // Un document d'origine OPAQUE récupère ses modules ES en mode CORS avec « Origin: null » :
  // sans autorisation explicite, il ne peut charger aucun script, fût-il servi par l'origine qui
  // l'a encadré. Le mesurer exige donc d'ouvrir CORS à « null » — c'est-à-dire à TOUT document
  // sandboxé du web, puisque « null » ne désigne personne. Ce coût est un argument de l'ADR 0002
  // contre les topologies à origine opaque, pas une commodité de développement.
  if (requestOrigin === "null") {
    headers["Access-Control-Allow-Origin"] = "null";
    headers.Vary = "Origin";
  }

  if (isolation === ISOLATION_REQUIRE_CORP) {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }

  // `Service-Worker-Allowed` est délibérément absent : le spike mesure la portée maximale qu'un
  // Service Worker applicatif obtient sans complaisance du serveur.
  //
  // `Strict-Transport-Security` est délibérément absent lui aussi, et l'ADR 0022 en porte le motif :
  // tout ce que ce dépôt sait servir est en `http:`, où RFC 6797 § 7.2 exige du navigateur qu'il
  // IGNORE l'en-tête. Le poser ici mettrait dans la source de vérité une politique inerte partout
  // où elle est mesurée — et HSTS engage un DOMAINE pour des mois, pas une arborescence. C'est une
  // obligation d'exploitant, écrite dans `docs/release-policy.md`, pas un en-tête de ce module.
  return headers;
}

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`L'option --${name} attend une valeur.`);
  }
  return value;
}

function readPort(argv, fallback) {
  const raw = readFlag(argv, "port");
  if (raw === null) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port invalide : ${raw}.`);
  }
  return port;
}

/**
 * @param {string[]} argv arguments bruts, `process.argv.slice(2)`
 * @param {Record<string, string | undefined>} [env] environnement du processus
 * @returns {{ role: string, host: string, port: number, appOrigin: string,
 *             crossOriginIsolated: boolean, workerSrcBlob: boolean }}
 */
export function parseServerOptions(argv, env = {}) {
  const role = readFlag(argv, "role") ?? "shell";
  if (!SERVER_ROLES.includes(role)) {
    throw new Error(`Rôle inconnu : ${role}. Valeurs admises : ${SERVER_ROLES.join(", ")}.`);
  }
  const isApp = role === "app";

  const workerSrcBlob = argv.includes("--worker-src-blob");
  if (workerSrcBlob && env[HARNAIS_CSP_ENV] !== HARNAIS_CSP_VALEUR) {
    throw new Error(
      `L'option --worker-src-blob élargit la CSP de la coquille (« worker-src 'self' blob: ») et ` +
        `n'est admise que par le harnais de mesure « npm run test:csp », qui pose ` +
        `${HARNAIS_CSP_ENV}=${HARNAIS_CSP_VALEUR}. L'ADR 0013 a retenu « worker-src 'self' » : ` +
        `aucun lancement de service ne doit servir la politique élargie.`,
    );
  }

  return Object.freeze({
    role,
    host: readFlag(argv, "host") ?? (isApp ? APP_HOST : SHELL_HOST),
    port: readPort(argv, isApp ? APP_PORT : SHELL_PORT),
    appOrigin: readFlag(argv, "app-origin") ?? APP_ORIGIN,
    // Drapeau sans valeur : la suite de compatibilité #2 sert TOUTES ses réponses sous COOP/COEP,
    // là où le spike #35 n'isole que la requête qui le demande.
    crossOriginIsolated: argv.includes("--cross-origin-isolated"),
    // Drapeau de MESURE (#52) : il ajoute `blob:` à `worker-src` pour que le harnais
    // `npm run test:csp` puisse comparer les deux politiques sur les trois moteurs. Il est REFUSÉ
    // partout ailleurs, ci-dessus — l'ADR 0013 a retenu `worker-src 'self'`.
    workerSrcBlob,
  });
}
