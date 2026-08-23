import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { ISOLATION_REQUIRE_CORP, parseServerOptions, securityHeaders } from "./serve-headers.mjs";

const publicRoot = resolve("public");
const sourceRoot = resolve("src");
const options = parseServerOptions(process.argv.slice(2));

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const servesSource = pathname.startsWith("/src/");
  const root = servesSource ? sourceRoot : publicRoot;
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(servesSource ? 5 : 1);
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
      }),
    });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(options.port, options.host, () => {
  process.stdout.write(
    `RailsBox Vault test server (${options.role}): http://${options.host}:${options.port}\n`,
  );
});
