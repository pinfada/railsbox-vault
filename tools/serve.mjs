import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  ISOLATION_REQUIRE_CORP,
  enTetesDAbsence,
  natureDArtefact,
  NATURES_DARTEFACT,
  parseServerOptions,
  securityHeaders,
} from "./serve-headers.mjs";

const publicRoot = resolve("public");
const sourceRoot = resolve("src");
// Les artefacts v86 du spike #4 ne sont pas versionnés : ils vivent sous `vendor/`, récupérés et
// vérifiés par `npm run vm:fetch`. Le serveur les expose en lecture seule, sous leur propre racine.
const vendorRoot = resolve("vendor");
// Les artefacts de l'image de référence (#5) ne sont pas versionnés : ils vivent sous
// `artifacts/reference-image/`, produits par `npm run image:build`. La preuve de reprise (#7) les
// sert à v86 dans le navigateur, en lecture seule, sous leur propre racine.
const artifactRoot = resolve("artifacts");
const options = parseServerOptions(process.argv.slice(2), process.env);

/**
 * HARNAIS de l'E2E hors ligne SEULEMENT (#247, D1g ; ADR 0046 § 6, #299) : donne au CODE de la coquille (tout ce
 * que la politique de cache classe `coquille`, hors `/artifacts/`) une fraîcheur de `<s>` secondes. Les en-têtes de
 * production le laissent en `no-cache` : un Worker NEUF, créé réseau coupé, ne peut alors pas importer ses modules,
 * et le démarrage hors connexion échoue AVANT de lire la réserve — c'est la moitié « code de la coquille » de #299.
 * Ce harnais modélise la condition que la décision de #299 devra garantir, pour éprouver ce que cette tranche livre.
 *
 * **Borné au banc de test** (revue de #298, second tour, constat 4) : la fraîcheur n'est lue QUE de l'argument
 * `--harnais-e2e-hors-ligne <secondes>`, que seul `playwright.e2e.config.mjs` passe, au seul serveur de la coquille.
 * Aucune variable d'environnement n'est lue ici : un `npm start` dont l'environnement porterait `VAULT_E2E_CODE_MAX_AGE`
 * (variable du banc, lue par la config Playwright et le lot 5 de `reprise.yml`) ne change pas d'en-têtes. Un argument
 * sans durée entière positive fait REFUSER le démarrage.
 */
const FANION_DU_HARNAIS = "--harnais-e2e-hors-ligne";
const dureeDuCodeEnCache = lireLeHarnais(process.argv.slice(2));

/** @returns {number | null} la fraîcheur du code en secondes, ou `null` sans harnais ; arrête le processus si mal posé. */
function lireLeHarnais(argv) {
  const rang = argv.indexOf(FANION_DU_HARNAIS);
  if (rang === -1) return null;
  const valeur = argv[rang + 1] ?? "";
  if (!/^[1-9][0-9]*$/.test(valeur)) {
    process.stderr.write(
      `Harnais de cache du code refusé : ${FANION_DU_HARNAIS} attend une durée en secondes (entier positif).\n`,
    );
    process.exit(1);
  }
  return Number.parseInt(valeur, 10);
}

function enTetesDeCacheDuHarnais(pathname) {
  if (dureeDuCodeEnCache === null) return {};
  if (pathname.startsWith("/artifacts/")) return {};
  if (natureDArtefact({ role: options.role, pathname }) !== NATURES_DARTEFACT.coquille) return {};
  return { "Cache-Control": `public, max-age=${dureeDuCodeEnCache}` };
}
// Une socket de bouclage accepte aussi les alias de son adresse. Servir le coffre sous
// localhost partagerait les cookies des autres applications localhost, quel que soit le port.
// Seuls le couple configuré et les alias DÉCLARÉS (`--alias`) sont admis ; un alias sans port
// vaut pour le port du serveur, jamais pour un autre.
const hotesAdmis = new Set(
  [`${options.host}:${options.port}`, ...options.aliases].map((hote) =>
    new URL(`http://${hote.includes(":") ? hote : `${hote}:${options.port}`}`).host.toLowerCase(),
  ),
);

const contentTypes = new Map([
  [".ico", "image/vnd.microsoft.icon"],
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

/** Racine et chemin relatif d'une requête, selon le préfixe d'URL. */
function resolveRoot(pathname) {
  if (pathname.startsWith("/src/")) return { root: sourceRoot, relativePath: pathname.slice(5) };
  if (pathname.startsWith("/vendor/")) return { root: vendorRoot, relativePath: pathname.slice(8) };
  if (pathname.startsWith("/artifacts/"))
    return { root: artifactRoot, relativePath: pathname.slice(11) };
  // Un chemin terminé par « / » désigne le document d'index du dossier ; aucune liste de fichiers
  // n'est jamais servie.
  const relativePath = pathname.endsWith("/")
    ? `${pathname.slice(1)}index.html`
    : pathname.slice(1);
  return { root: publicRoot, relativePath };
}

/** Une erreur HTTP ne révèle aucun chemin local et n'est jamais mise en cache. */
function refuser(response, statut, message, entetes = {}) {
  response
    .writeHead(statut, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...enTetesDAbsence(),
      ...entetes,
    })
    .end(message);
}

/** Refuse aussi les séparateurs Windows et les flux NTFS, même sur un hôte Unix. */
function lireAdresse(cible) {
  if (!cible.startsWith("/") || cible.startsWith("//") || cible.includes("\\")) {
    throw new Error("Invalid request target");
  }
  const url = new URL(cible, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  if (
    pathname.startsWith("//") ||
    /[\\:]/u.test(pathname) ||
    [...pathname].some(
      (caractere) => caractere.charCodeAt(0) < 32 || caractere.charCodeAt(0) === 127,
    ) ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error("Invalid path");
  return { url, pathname };
}

createServer(async (request, response) => {
  if (!hotesAdmis.has(request.headers.host?.toLowerCase() ?? "")) {
    refuser(response, 421, "Unexpected host");
    return;
  }
  let adresse;
  try {
    adresse = lireAdresse(request.url ?? "/");
  } catch {
    refuser(response, 400, "Bad request");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    refuser(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }
  const { url, pathname } = adresse;
  const { root, relativePath } = resolveRoot(pathname);
  const candidate = resolve(root, relativePath);

  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    refuser(response, 403, "Forbidden");
    return;
  }

  let fichier;
  try {
    const racineReelle = await realpath(root);
    const cheminReel = await realpath(candidate);
    // Même un lien INTERNE est refusé : son alias pourrait recevoir les exemptions CSP d'un
    // autre chemin. La racine configurée peut elle-même être un lien (checkout de développement).
    if (relative(resolve(racineReelle, relativePath), cheminReel) !== "") {
      refuser(response, 403, "Forbidden");
      return;
    }
    // Décision (a) de la revue de #225 (constat 1) : ouvrir D'ABORD, `fstat` ENSUITE sur le
    // descripteur déjà ouvert — plus de fenêtre entre un contrôle de type et la lecture. Un `stat`
    // préalable laissait cette fenêtre à un processus LOCAL qui substituerait le fichier entre les
    // deux appels ; `O_NONBLOCK` évite le seul risque que ce `stat` prévenait (l'ouverture en
    // lecture d'un tube nommé attendrait un écrivain) : POSIX rend cette ouverture immédiate même
    // sans écrivain. Sans effet sous Windows, où aucun tube nommé ne vit dans l'arbre servi — le
    // `fstat` qui suit reste la vraie garde, sur les deux systèmes.
    fichier = await open(cheminReel, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const metadata = await fichier.stat();
    if (!metadata.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(candidate)) ?? "application/octet-stream",
      ...securityHeaders({
        role: options.role,
        pathname,
        // Deux voies vers la même politique : l'option de serveur, que la suite de compatibilité
        // applique à toutes ses réponses, et le paramètre de requête, qui laisse le spike #35
        // comparer une coquille isolée et une coquille nue sans redémarrer de serveur.
        isolation: options.crossOriginIsolated
          ? ISOLATION_REQUIRE_CORP
          : url.searchParams.get("isolation"),
        appOrigin: options.appOrigin,
        requestOrigin: request.headers.origin ?? null,
        workerSrcBlob: options.workerSrcBlob,
      }),
      ...enTetesDeCacheDuHarnais(pathname),
    });
    if (request.method === "HEAD") response.end();
    else await pipeline(fichier.createReadStream({ autoClose: false }), response);
  } catch {
    // Une ABSENCE n'est jamais cachable. Sous `/vendor/v86/artefacts/*` le `_headers` publié
    // annonce un an d'`immutable` pour le CHEMIN, et un 404 gardé un an n'aurait aucun geste de
    // récupération côté client (constat 1 de la revue de #123).
    if (response.headersSent) response.destroy();
    else refuser(response, 404, "Not found");
  } finally {
    // L'échec d'une fermeture n'est plus avalé (constat 2 de la revue de #225) : une ligne sur
    // `stderr`, sans chemin local ni pile complète — même discipline que les réponses d'erreur.
    await fichier?.close().catch((erreur) => {
      process.stderr.write(
        `serve: fermeture du descripteur en échec (${erreur.code ?? "inconnu"})\n`,
      );
      response.destroy();
    });
  }
}).listen(options.port, options.host, () => {
  process.stdout.write(
    `RailsBox Vault test server (${options.role}): http://${options.host}:${options.port}\n`,
  );
});
