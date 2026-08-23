import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const publicRoot = resolve("public");
const sourceRoot = resolve("src");
const portFlag = process.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4173;
// L'isolation multi-origine reste optionnelle : elle est nécessaire pour mesurer réellement
// SharedArrayBuffer et Atomics.wait, mais ne doit pas changer les conditions du harnais par défaut.
const isolatesOrigin = process.argv.includes("--cross-origin-isolated");

const isolationHeaders = isolatesOrigin
  ? {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    }
  : {};

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
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
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...isolationHeaders,
    });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`RailsBox Vault test server: http://127.0.0.1:${port}\n`);
});
