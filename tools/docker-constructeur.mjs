// Choix du constructeur Docker pour les images i386 (#295).
//
// État « rouge » : le constructeur par défaut, sans sonde. Voir le commit suivant.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(
  readFileSync(join(RACINE, "tools", "build-reference-image", "sources.json"), "utf8"),
);
const image = sources.images.rootfs;

/** Dockerfile de la sonde : une socket peut-elle se créer dans un `RUN` 32 bits ? */
export const DOCKERFILE_SONDE = `FROM ${image.reference}@${image.digest}
SHELL ["linux32", "/bin/sh", "-c"]
RUN out=$(bash -c 'exec 3<>/dev/tcp/127.0.0.1/9' 2>&1 || true); \\
    case "$out" in \\
      *"Function not implemented"*|*"Operation not permitted"*) echo "sonde: $out"; exit 1 ;; \\
    esac
`;

/** @returns {{ constructeur: string | null, argumentsDeBuild: (args: string[]) => string[] }} */
export function obtenirConstructeur() {
  return {
    constructeur: null,
    argumentsDeBuild: (args) => ["build", "--load", ...args],
  };
}
