// Emplacements des artefacts v86. Isolés dans leur module : `fetch-v86.mjs` est un exécutable qui
// agit dès son import, et aucun autre outil ne doit le déclencher pour connaître un chemin.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(REPOSITORY_ROOT, "vendor", "v86", "MANIFEST.json");
export const ARTIFACT_DIRECTORY = join(REPOSITORY_ROOT, "vendor", "v86", "artefacts");
/** Chemin HTTP servi par `tools/serve.mjs` pour les mêmes artefacts. */
export const ARTIFACT_URL_PREFIX = "/vendor/v86/artefacts/";
