/**
 * Le PÉRIMÈTRE du « sans racine » : AUCUN chemin du produit SERVI n'atteint la migration ni
 * l'engagement (#188, revue de sécurité, HIGH-2).
 *
 * ## Ce que la revue a trouvé, et pourquoi ce cliquet plutôt qu'un compteur
 *
 * `motifDeServiceEventuel` (`opfs-racine-initiale.mjs`) juge un journal sur sa séquence, sa
 * génération et son nombre d'entrées — et les TROIS motifs qui autorisent une racine sans racine
 * (`creation`, `migration`, `engagement`) écrivent la MÊME chose sur ces trois champs : une racine
 * de naissance, séquence zéro, génération zéro, aucune entrée. Le motif lui-même ne vit QUE dans le
 * rapport d'ouverture, jamais sur le support. Mesuré empiriquement (probe jetable, rejouant la
 * reproduction du relecteur sur le double déterministe) : une racine `migration` posée sur un
 * volume qu'on a d'abord mis EN SERVICE, puis dont on a effacé le journal ET le témoin de séquence
 * comme le ferait un adversaire qui écrit déjà dans l'origine de confiance, est OCTET POUR OCTET
 * dans la même forme qu'une racine `creation` légitime, POST-DATATION — même séquence, même
 * génération, un compteur de scellements du même ordre de grandeur. Aucun champ de la racine, ni
 * aucun compteur qu'un appelant lui fournit, ne permet de les distinguer : l'un et l'autre sont
 * fournis par l'APPELANT, jamais mesurés depuis un état antérieur que le support garderait.
 *
 * **Un compteur qui prétendrait trancher mentirait.** Ce que la revue elle-même retient comme la
 * seule chose qui rend l'état aujourd'hui INATTEIGNABLE n'est pas une propriété du disque, c'est une
 * propriété de la TOPOLOGIE du produit : `poserLaRacineInitialeSurAccesBrut` (la racine `migration`)
 * et la vérification d'engagement (la racine `engagement`, dans `migration-source-chiffree.mjs`) ne
 * sont appelées que depuis `public/vm/` — les bancs de la machine virtuelle —, et `public/vm/` est
 * explicitement RETIRÉ de la publication (`tools/publier-arborescences.mjs`, exclusion `public/vm/`).
 * C'est CET invariant que ce cliquet tient, en suivant le graphe d'IMPORT plutôt qu'en confrontant un
 * compteur : le jour où un chemin réellement servi importerait l'un de ces deux modules, ce serait
 * une revue à ouvrir, pas une ligne à corriger ici.
 *
 * Voir l'ADR 0037, section « Ce que ce geste ne peut jamais détruire, et pourquoi le support ne
 * suffit pas à l'affirmer seul ».
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Les DEUX points d'entrée d'un chemin réellement SERVI : la page (assemble `src/coquille/` par
 * `public/main.mjs`) et le Worker de confiance (`public/runtime-worker.mjs`, qui exécute
 * `src/vm/*` — c'est LUI qui ouvrirait un volume, pas la page). Un Worker se charge par URL, pas
 * par `import` : sans ce second point d'entrée, sa fermeture d'import resterait invisible d'ici.
 */
const ENTREES_SERVIES = ["public/main.mjs", "public/runtime-worker.mjs"];

/** Les DEUX modules qui écrivent une racine `migration` ou `engagement` — jamais `creation`. */
const MODULES_DANGEREUX = [
  "src/vm/opfs-migration-target.mjs",
  "src/vm/migration-source-chiffree.mjs",
];

/** Un banc de la VM qui, lui, doit légitimement les atteindre — le TÉMOIN que le graphe fonctionne. */
const BANC_QUI_DOIT_ATTEINDRE = "public/vm/reference-worker-phases-migration.mjs";

// Trois formes d'import ES : `... from "x"` (nommé ou par défaut), `import("x")` (dynamique), et
// l'import de SIMPLE EFFET `import "x"` sans liaison. Ne suivre que la première laisserait passer
// un import ajouté sous l'une des deux autres formes sans que ce cliquet ne le voie.
const SPECIFICATEUR =
  /\bfrom\s+["']([^"']+)["']|(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

/** Résout un spécificateur d'import ABSOLU (`/src/...`) ou RELATIF (`./...`, `../...`) en chemin dépôt. */
function resoudre(specificateur, depuis) {
  if (specificateur.startsWith("/")) return specificateur.slice(1);
  if (specificateur.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(depuis), specificateur));
  }
  return null;
}

/** Les spécificateurs importés par UN fichier, résolus en chemins dépôt (les externes écartés). */
async function importsDe(fichier) {
  let contenu;
  try {
    contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
  } catch {
    return [];
  }
  const resolus = [];
  for (const correspondance of contenu.matchAll(SPECIFICATEUR)) {
    const specificateur = correspondance[1] ?? correspondance[2] ?? correspondance[3];
    const resolu = resoudre(specificateur, fichier);
    if (resolu !== null) resolus.push(resolu);
  }
  return resolus;
}

/** La FERMETURE transitive d'import depuis une liste de racines, par parcours en largeur. */
async function fermetureDImport(racines) {
  const visites = new Set();
  const file = [...racines];
  while (file.length > 0) {
    const courant = file.shift();
    if (visites.has(courant)) continue;
    visites.add(courant);
    for (const importe of await importsDe(courant)) {
      if (!visites.has(importe)) file.push(importe);
    }
  }
  return visites;
}

test("aucun chemin réellement SERVI n'importe, même transitivement, la migration ou l'engagement", async () => {
  const fermeture = await fermetureDImport(ENTREES_SERVIES);
  const atteints = MODULES_DANGEREUX.filter((module) => fermeture.has(module));

  assert.deepEqual(
    atteints,
    [],
    "Un chemin servi atteint un module qui écrit une racine `migration` ou `engagement` : " +
      "l'invariant de l'ADR 0037 est rompu, et c'est une revue de sécurité qu'il faut ouvrir, " +
      "pas cette liste qu'il faut corriger.",
  );
});

test("témoin : le même parcours atteint BIEN la migration depuis le banc qui en a besoin", async () => {
  // Sans ce témoin, le test précédent passerait aussi si `importsDe` ne suivait rien : un cliquet
  // qui ne peut jamais mordre ne prouve rien.
  const fermeture = await fermetureDImport([BANC_QUI_DOIT_ATTEINDRE]);
  const atteints = MODULES_DANGEREUX.filter((module) => fermeture.has(module));

  assert.ok(
    atteints.length > 0,
    "le banc de migration n'atteint plus aucun module dangereux : le parcours d'import ne " +
      "fonctionne pas, ou le banc a changé de forme — dans les deux cas, ce cliquet ne prouve rien.",
  );
});

test("les deux entrées servies existent RÉELLEMENT, et le graphe qu'elles ouvrent n'est pas vide", async () => {
  for (const entree of ENTREES_SERVIES) {
    const fermeture = await fermetureDImport([entree]);
    assert.ok(fermeture.size > 1, `${entree} n'importe rien : le parcours ne part de nulle part`);
  }
});
