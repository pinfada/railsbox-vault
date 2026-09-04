/**
 * Contrôle de taille des FICHIERS : **aucun fichier de `src/` ni de `public/vm/` ne dépasse
 * 800 lignes, et aucun ne dépasse 700 sans être inscrit ici avec son motif.**
 *
 * Le plafond des 800 lignes était écrit dans `docs/development.md` depuis l'origine du dépôt, et
 * rien ne le mesurait. Le relevé de #93 a trouvé trois fichiers à 789, 791 et 798 lignes : la
 * convention n'avait pas été violée, elle avait été atteinte — ce qui revient au même à la
 * prochaine évolution. #18 (bloc authentifié, format v3) devait justement toucher deux d'entre eux,
 * et on n'ajoute pas un format chiffré dans un fichier qui ne peut plus grandir d'une ligne.
 *
 * ## Deux seuils, et pourquoi il en faut deux
 *
 * Un plafond seul se découvre TROP TARD : le jour où il refuse, c'est au milieu de la tranche qui
 * avait besoin de place, et la scission se fait alors sous la pression du travail en cours. Le
 * SEUIL D'ALERTE, lui, est franchi longtemps avant, quand la scission est encore un choix libre.
 *
 *  - **800 lignes — plafond.** Aucune exception, aucune liste : un fichier qui l'atteint se scinde.
 *  - **700 lignes — alerte.** Un fichier au-delà est inscrit ci-dessous, avec la taille relevée et
 *    la raison pour laquelle il n'est pas encore scindé. L'inscription est un CLIQUET : il ne peut
 *    plus grandir sans qu'une revue l'accepte, et une inscription périmée sort de la liste.
 *
 * Les lignes se comptent comme `wc -l` les compte : commentaires et lignes vides compris.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Plafond du dépôt, en lignes. `docs/development.md` § « Taille des unités ». */
const PLAFOND = 800;

/** Seuil au-delà duquel un fichier doit être inscrit, longtemps avant de buter sur le plafond. */
const ALERTE = 700;

/** Code de production servi au navigateur. `tests/` et `tools/` ne sont pas couverts. */
const RACINES = ["src", "public/vm"];

/**
 * Fichiers entre l'alerte et le plafond, EXAMINÉS et gardés en l'état. Ajouter une ligne ici demande
 * un motif qui tienne devant une revue, et la taille relevée le jour de l'inscription.
 *
 * Elle est restée VIDE de #93 à #65. #93 avait scindé les trois fichiers qui approchaient du
 * plafond : `src/vm/generation-store.mjs` (798), `src/vm/opfs-block-backend.mjs` (791) et
 * `public/vm/reference-worker.mjs` (789).
 *
 * @type {{ fichier: string, lignes: number, motif: string }[]}
 */
const SOUS_SURVEILLANCE = [
  {
    fichier: "src/vm/generation-store.mjs",
    lignes: 738,
    motif:
      "#65 y ajoute DEUX accesseurs en lecture — `sequenceValidee` et `racineValidee` — parce que " +
      "la liaison d'un instantané (ADR 0024) est exactement ce que la racine authentifie, et que " +
      "seul le magasin le sait. La Definition of Ready de #65 borne explicitement l'intervention " +
      "sur ce fichier à « l'exposition en lecture de la racine validée » : le scinder pour trente " +
      "lignes aurait dépassé ce mandat, et scinder une machine à états pour la faire tenir sous " +
      "un seuil est le genre de découpage qui rend un protocole illisible. Le fichier reste à " +
      "62 lignes du plafond ; la prochaine tranche qui y touchera devra le scinder.",
  },
];

/** Nombre de lignes d'un contenu, tel que `wc -l` le compte. */
function compterLignes(contenu) {
  const lignes = contenu.split("\n");
  return lignes.at(-1) === "" ? lignes.length - 1 : lignes.length;
}

/** Relève tous les modules du périmètre, avec leur taille. */
async function relever() {
  const releve = [];
  for (const racine of RACINES) {
    const entrees = await readdir(path.join(REPO_ROOT, racine), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entree of entrees) {
      if (!entree.isFile() || !entree.name.endsWith(".mjs")) continue;
      const absolu = path.join(entree.parentPath ?? entree.path, entree.name);
      const fichier = path.relative(REPO_ROOT, absolu).replaceAll("\\", "/");
      releve.push({ fichier, lignes: compterLignes(await readFile(absolu, "utf8")) });
    }
  }
  return releve.sort((a, b) => b.lignes - a.lignes);
}

const releve = await relever();

test("le relevé porte bien sur les modules du dépôt", () => {
  assert.ok(releve.length > 0, "aucun module relevé : le périmètre est inopérant");
  assert.ok(
    releve.some(({ fichier }) => fichier.startsWith("public/vm/")),
    "aucun module de `public/vm/` relevé : le périmètre ne couvre pas le code servi au navigateur",
  );
});

test("aucun fichier ne dépasse le plafond de 800 lignes", () => {
  const debordements = releve
    .filter(({ lignes }) => lignes > PLAFOND)
    .map(({ fichier, lignes }) => `${fichier} : ${lignes} lignes`);

  assert.deepEqual(
    debordements,
    [],
    "Le plafond n'admet aucune exception : scindez ces fichiers en modules cohésifs.",
  );
});

test("aucun fichier au-delà du seuil d'alerte n'échappe à la liste", () => {
  const inscrits = new Set(SOUS_SURVEILLANCE.map(({ fichier }) => fichier));
  const surprises = releve
    .filter(({ fichier, lignes }) => lignes > ALERTE && !inscrits.has(fichier))
    .map(({ fichier, lignes }) => `${fichier} : ${lignes} lignes`);

  assert.deepEqual(
    surprises,
    [],
    `Ces fichiers approchent du plafond de ${PLAFOND} lignes. Scindez-les tant que c'est un choix, ` +
      "ou inscrivez-les dans ce fichier avec leur motif :",
  );
});

test("aucun fichier inscrit n'a grandi au-delà de la taille relevée", () => {
  const mesures = new Map(releve.map(({ fichier, lignes }) => [fichier, lignes]));
  const debordements = SOUS_SURVEILLANCE.filter(
    (inscrit) => (mesures.get(inscrit.fichier) ?? 0) > inscrit.lignes,
  ).map(
    (inscrit) =>
      `${inscrit.fichier} : ${mesures.get(inscrit.fichier)} lignes, inscrit à ${inscrit.lignes}`,
  );

  assert.deepEqual(
    debordements,
    [],
    "La liste est un cliquet : une inscription ne grandit pas sans que la revue l'accepte.",
  );
});

test("aucune inscription n'est périmée", () => {
  const mesures = new Map(releve.map(({ fichier, lignes }) => [fichier, lignes]));
  const perimees = SOUS_SURVEILLANCE.filter(
    (inscrit) => (mesures.get(inscrit.fichier) ?? 0) <= ALERTE,
  ).map(({ fichier }) => fichier);

  assert.deepEqual(
    perimees,
    [],
    "Ces fichiers sont repassés sous le seuil d'alerte ou ont disparu : retirez leur inscription.",
  );
});
