// Emplacements des artefacts v86. Isolés dans leur module : `fetch-v86.mjs` est un exécutable qui
// agit dès son import, et aucun autre outil ne doit le déclencher pour connaître un chemin.
//
// Le NOM des fichiers de `vendor/v86/artefacts/` est celui de leur ADRESSE, empreinte comprise
// (#123) : `src/v86-adresses.mjs` le dérive, `npm run vm:fetch` l'écrit, `tools/serve.mjs` le sert
// tel quel et la publication le recopie tel quel. Un seul nom, du disque au navigateur, plutôt
// qu'une correspondance à tenir en double entre le serveur de développement et la publication —
// deux implémentations d'une même règle finissent par diverger, et l'écart ne se verrait qu'en
// production.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adressesDuManifeste, nomAdresse } from "../src/v86-adresses.mjs";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(REPOSITORY_ROOT, "vendor", "v86", "MANIFEST.json");
export const ARTIFACT_DIRECTORY = join(REPOSITORY_ROOT, "vendor", "v86", "artefacts");

/** Nom de fichier, sur le DISQUE, d'un artefact déclaré par le manifeste. */
export function nomDeFichier({ name, sha256 }) {
  return nomAdresse(name, sha256);
}

/** Chemin absolu du même artefact. */
export function cheminDeLArtefact(artefact) {
  return join(ARTIFACT_DIRECTORY, nomDeFichier(artefact));
}

/** Noms de fichiers attendus dans `vendor/v86/artefacts/`, indexés par nom d'artefact. */
export function nomsDeFichiers(manifeste) {
  return new Map(manifeste.artifacts.map((artefact) => [artefact.name, nomDeFichier(artefact)]));
}

/**
 * Le manifeste d'épinglage du dépôt.
 *
 * Lu SYNCHRONEMENT, et c'est délibéré : plusieurs épreuves décident au chargement de leur module si
 * le banc est exécutable (`const raison = raisonDIndisponibilite()`), et une lecture asynchrone les
 * obligerait toutes à devenir asynchrones pour cinq kibioctets de JSON. La dérivation d'adresse, elle,
 * reste dans `src/v86-adresses.mjs`, où le navigateur la partage.
 */
export function lireManifesteV86() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

/**
 * Chemins de disque des artefacts, indexés par leur nom d'ADR 0003.
 *
 * C'est la porte des outils et des épreuves de Node : ils demandent « v86.wasm » et reçoivent le
 * fichier que le manifeste épingle sous ce nom. Aucun d'eux n'a besoin de savoir que le nom de
 * fichier porte une empreinte, et aucun ne doit l'écrire.
 */
export function cheminsDesArtefacts(manifeste = lireManifesteV86()) {
  return new Map(manifeste.artifacts.map((a) => [a.name, cheminDeLArtefact(a)]));
}

/** Adresses HTTP des mêmes artefacts, telles que `tools/serve.mjs` et la publication les servent. */
export function adressesServiesV86(manifeste = lireManifesteV86()) {
  return adressesDuManifeste(manifeste);
}

/**
 * Noms d'artefacts que le disque ne porte pas — le diagnostic « exécuter npm run vm:fetch ».
 *
 * Elle rend les noms de l'ADR 0003 et non les noms de fichiers : c'est ce qu'un message d'erreur
 * doit dire à qui lit, et c'est ce que le manifeste nomme.
 */
export function artefactsV86Absents(noms, manifeste = lireManifesteV86()) {
  const chemins = cheminsDesArtefacts(manifeste);
  return noms.filter((nom) => {
    const chemin = chemins.get(nom);
    return chemin === undefined || !existsSync(chemin);
  });
}
