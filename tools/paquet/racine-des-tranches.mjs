// La RACINE des tranches de 8 Mio d'un artefact, calculée à la FABRICATION (#247, lot D1c).
//
// Le magasin d'artefacts (`src/vm/magasin-d-artefacts.mjs`) vérifie un artefact rangé en OPFS contre
// la racine que le DESCRIPTEUR porte : elle vient de l'origine, pas de l'OPFS. Elle doit donc naître
// ici, sur les octets mêmes que la coquille vérifiera — l'image DÉCOMPRESSÉE —, et selon la MÊME
// définition : `tranchesEtRacineSync` est celle du magasin, pas une copie.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { tranchesEtRacineSync } from "../../src/vm/magasin-d-artefacts.mjs";

const sha256 = (octets) => createHash("sha256").update(octets).digest("hex");

/**
 * Les empreintes des tranches de 8 Mio d'un fichier et leur racine.
 *
 * @param {string} chemin
 * @returns {{ tranches: string[], racine: string }}
 */
export function tranchesEtRacineDeFichier(chemin) {
  return tranchesEtRacineSync(readFileSync(chemin), sha256);
}

/** La seule racine, celle que le descripteur sert. @param {string} chemin */
export const racineDeFichier = (chemin) => tranchesEtRacineDeFichier(chemin).racine;
