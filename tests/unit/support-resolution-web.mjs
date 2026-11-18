// Crochet de RÉSOLUTION pour les épreuves qui chargent un module de `public/` tel que le navigateur
// le sert : les importations `/src/…` y sont des chemins ABSOLUS de la racine web, que Node ne sait
// pas résoudre. Le crochet les ramène à `src/` du dépôt, et ne fait rien d'autre.
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = fileURLToPath(new URL("../../", import.meta.url));

export function resolve(specifier, contexte, suivant) {
  if (specifier.startsWith("/src/")) {
    return suivant(pathToFileURL(`${RACINE}${specifier.slice(1)}`).href, contexte);
  }
  return suivant(specifier, contexte);
}
