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
 * CSP de la coquille de confiance. `default-src 'none'` impose de nommer chaque capacité ;
 * `frame-src` n'autorise que l'origine applicative déclarée, ce qui rend observable toute
 * tentative d'encadrer un document tiers.
 * @param {string} appOrigin
 */
export function shellContentSecurityPolicy(appOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
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
 * @param {{ role: string, pathname: string, isolation: string | null, appOrigin: string,
 *           requestOrigin?: string | null }} request
 * @returns {Record<string, string>}
 */
export function securityHeaders({ role, pathname, isolation, appOrigin, requestOrigin = null }) {
  if (!SERVER_ROLES.includes(role)) {
    throw new Error(`Rôle de serveur inconnu : ${role}.`);
  }

  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // L'origine applicative doit rester encadrable par la coquille ; l'origine coquille, non.
    "Cross-Origin-Resource-Policy": role === "app" ? "cross-origin" : "same-origin",
  };

  if (role === "shell" && !isApplicationTerritory(pathname) && !isCapabilityProbe(pathname)) {
    headers["Content-Security-Policy"] = shellContentSecurityPolicy(appOrigin);
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
 * @returns {{ role: string, host: string, port: number, appOrigin: string }}
 */
export function parseServerOptions(argv) {
  const role = readFlag(argv, "role") ?? "shell";
  if (!SERVER_ROLES.includes(role)) {
    throw new Error(`Rôle inconnu : ${role}. Valeurs admises : ${SERVER_ROLES.join(", ")}.`);
  }
  const isApp = role === "app";
  return Object.freeze({
    role,
    host: readFlag(argv, "host") ?? (isApp ? APP_HOST : SHELL_HOST),
    port: readPort(argv, isApp ? APP_PORT : SHELL_PORT),
    appOrigin: readFlag(argv, "app-origin") ?? APP_ORIGIN,
    // Drapeau sans valeur : la suite de compatibilité #2 sert TOUTES ses réponses sous COOP/COEP,
    // là où le spike #35 n'isole que la requête qui le demande.
    crossOriginIsolated: argv.includes("--cross-origin-isolated"),
  });
}
