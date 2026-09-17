import { open, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  ISOLATION_REQUIRE_CORP,
  enTetesDAbsence,
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

const contentTypes = new Map([
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
  // Une socket de bouclage accepte aussi les alias de son adresse. Servir le coffre sous
  // localhost partagerait les cookies des autres applications localhost, quel que soit le port.
  const hoteAttendu = new URL(`http://${options.host}:${options.port}`).host;
  if (request.headers.host?.toLowerCase() !== hoteAttendu.toLowerCase()) {
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
    // Ne pas ouvrir un tube nommé : son ouverture en lecture pourrait attendre un écrivain.
    if (!(await stat(cheminReel)).isFile()) throw new Error("Not a file");
    // Le fichier vérifié et le flux partagent un descripteur ; aucune seconde ouverture entre
    // le contrôle du type et la lecture. Le système de fichiers local reste de confiance.
    fichier = await open(cheminReel, "r");
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
    await fichier?.close().catch(() => response.destroy());
  }
}).listen(options.port, options.host, () => {
  process.stdout.write(
    `RailsBox Vault test server (${options.role}): http://${options.host}:${options.port}\n`,
  );
});
