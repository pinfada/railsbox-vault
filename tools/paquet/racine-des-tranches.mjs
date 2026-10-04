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

/**
 * La seule racine, celle que le descripteur sert — CONFRONTÉE au `sha256` que le descripteur porte
 * pour le même fichier : les deux viennent d'une seule lecture. Une racine fausse ferait réécrire
 * l'artefact à chaque démarrage (revue de sécurité du 04/10/2026, constat 2) : la fabrication refuse.
 *
 * @param {string} chemin
 * @param {string} [sha256Attendu] le `sha256` déclaré pour ce fichier
 */
export function racineDeFichier(chemin, sha256Attendu) {
  const octets = readFileSync(chemin);
  if (sha256Attendu !== undefined && sha256(octets) !== sha256Attendu) {
    throw new Error(
      `Racine refusée pour ${chemin} : le fichier ne donne pas le sha256 déclaré ${sha256Attendu}.`,
    );
  }
  return tranchesEtRacineSync(octets, sha256).racine;
}
