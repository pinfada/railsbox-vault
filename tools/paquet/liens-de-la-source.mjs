// Les LIENS SYMBOLIQUES de la source n'entrent pas dans un paquet (#342).
//
// La copie de l'arbre filtré (`copyFileSync`) SUIT les liens : elle recopie la CIBLE sous le nom du
// lien. Un lien au nom anodin — `config/notes.txt` — qui pointe vers `config/master.key`, vers un
// journal exclu ou vers `~/.ssh/id_ed25519` faisait donc entrer dans une image servie publiquement
// ce que les exclusions et le refus des secrets par nom avaient écarté. Le balayage regardait le nom
// du lien ; la copie prenait le contenu de la cible.
//
// La règle est simple : AUCUN lien symbolique n'entre, quelle que soit sa cible. Recopier un lien
// comme un lien (plutôt que sa cible) supposerait que la cible entre aussi, et qu'elle reste dans la
// source : deux conditions de plus à vérifier, pour un usage rare dans une application Rails. Le
// rapport dit OÙ pointe chaque lien, pour que la correction soit évidente.

import { lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { cheminExclu } from "./exclusions-de-la-source.mjs";
import { secretsPresents } from "./identite-de-l-application.mjs";

/** Vrai si ce chemin de la source est un lien symbolique (le lien lui-même, sans le suivre). */
export function estUnLien(source, relatif) {
  try {
    return lstatSync(join(source, relatif)).isSymbolicLink();
  } catch {
    // Un fichier qui a disparu entre la liste et l'examen n'est pas un lien : la copie échouera
    // sur lui, bruyamment, et c'est le bon comportement.
    return false;
  }
}

/** Où pointe le lien, dit pour une personne : hors de la source, vers un exclu, ou vers un chemin. */
function cibleDecrite(source, relatif) {
  const brute = readlinkSync(join(source, relatif));
  const absolue = isAbsolute(brute)
    ? resolve(brute)
    : resolve(dirname(join(source, relatif)), brute);
  const depuisLaSource = relative(resolve(source), absolue);
  // Sous Windows, une cible sur un autre lecteur rend un chemin ABSOLU : elle est dehors aussi.
  const dehors =
    depuisLaSource === ".." || depuisLaSource.startsWith(`..${sep}`) || isAbsolute(depuisLaSource);
  if (dehors) {
    return "il pointe hors de la source : ce qu'il désigne n'appartient pas à l'application";
  }
  const cible = depuisLaSource === "" ? "." : depuisLaSource.split(sep).join("/");
  if (cheminExclu(cible) || secretsPresents([cible]).length > 0) {
    return `il pointe vers « ${cible} », qu'un paquet ne contient jamais`;
  }
  return `il pointe vers « ${cible} »`;
}

/**
 * Les liens symboliques parmi les fichiers RETENUS, en anomalies.
 *
 * @param {string} source racine de la source
 * @param {readonly string[]} fichiers chemins relatifs, à barres obliques
 * @returns {Array<{ code: string, fichier: string, quoi: string, pourquoi: string, changer: string }>}
 */
export function liensSymboliques(source, fichiers) {
  return fichiers
    .filter((relatif) => estUnLien(source, relatif))
    .map((relatif) => ({
      code: "lien-symbolique",
      fichier: relatif,
      quoi: `« ${relatif} » est un lien symbolique ; ${cibleDecrite(source, relatif)}.`,
      pourquoi:
        "la copie du paquet suivrait le lien et embarquerait le contenu de sa cible sous un nom " +
        "anodin, dans une image que tout visiteur télécharge.",
      changer:
        "remplacez le lien par une vraie copie du fichier s'il fait partie de l'application, " +
        "ou retirez-le de la source.",
    }));
}
