/** Où la candidate est déposée après vérification : hors du dépôt versionné, sous `reports/`. */
import { fileURLToPath } from "node:url";

export const RACINE_CANDIDATE = fileURLToPath(
  new URL("../../../reports/spike-gcm-siv/candidate/", import.meta.url),
);
export const MANIFESTE = fileURLToPath(new URL("./MANIFEST.json", import.meta.url));
