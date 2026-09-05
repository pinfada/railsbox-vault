import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

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

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const { root, relativePath } = resolveRoot(pathname);
  const candidate = resolve(root, relativePath);

  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const metadata = await stat(candidate);
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
    createReadStream(candidate).pipe(response);
  } catch {
    // Une ABSENCE n'est jamais cachable. Sous `/vendor/v86/artefacts/*` le `_headers` publié
    // annonce un an d'`immutable` pour le CHEMIN, et un 404 gardé un an n'aurait aucun geste de
    // récupération côté client (constat 1 de la revue de #123).
    response
      .writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        ...enTetesDAbsence(),
      })
      .end("Not found");
  }
}).listen(options.port, options.host, () => {
  process.stdout.write(
    `RailsBox Vault test server (${options.role}): http://${options.host}:${options.port}\n`,
  );
});
