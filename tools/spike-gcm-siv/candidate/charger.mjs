/**
 * Charge la candidate DÉJÀ VÉRIFIÉE, ou dit pourquoi elle est absente.
 *
 * Le chargement recalcule les empreintes une seconde fois, juste avant l'import : `preparer` les a
 * vérifiées à la récupération, celui-ci les vérifie à l'usage. C'est la double confrontation de
 * l'ADR 0021 décision 3, et elle a ici une limite qui est le cœur du verdict du spike — en
 * JavaScript, cette seconde vérification n'empêche RIEN : le module est exécuté par `import`, donc
 * après coup. Seul un artefact WebAssembly se vérifie AVANT instanciation.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { MANIFESTE, RACINE_CANDIDATE } from "./emplacement.mjs";

/** @returns {Promise<{disponible: boolean, raison?: string, identite?: string, sceller?: Function, ouvrir?: Function}>} */
export async function chargerCandidate() {
  let manifeste;
  try {
    manifeste = JSON.parse(await readFile(MANIFESTE, "utf8"));
  } catch (cause) {
    return { disponible: false, raison: `manifeste illisible : ${cause.message}` };
  }

  for (const artefact of manifeste.artifacts) {
    let octets;
    try {
      octets = await readFile(join(RACINE_CANDIDATE, artefact.name));
    } catch {
      return {
        disponible: false,
        raison: "non préparée — lancer `node tools/spike-gcm-siv/preparer-candidate.mjs`",
      };
    }
    const obtenue = createHash("sha256").update(octets).digest("hex");
    if (obtenue !== artefact.sha256) {
      return { disponible: false, raison: `empreinte de ${artefact.name} différente du manifeste` };
    }
  }

  const module = await import(pathToFileURL(join(RACINE_CANDIDATE, "aes.js")).href);
  if (typeof module.gcmsiv !== "function") {
    return { disponible: false, raison: "l'export `gcmsiv` a disparu de la candidate" };
  }

  return {
    disponible: true,
    identite: manifeste.pins.npmPackage,
    sceller: async (cle, nonce, clair, donneesAssociees) =>
      module.gcmsiv(cle, nonce, donneesAssociees).encrypt(clair),
    ouvrir: async (cle, nonce, scelle, donneesAssociees) =>
      module.gcmsiv(cle, nonce, donneesAssociees).decrypt(scelle),
  };
}
