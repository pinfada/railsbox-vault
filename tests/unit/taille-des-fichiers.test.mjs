/**
 * Contrôle de taille des FICHIERS : **aucun fichier de `src/` ni de `public/` ne dépasse
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
 *
 * ## `public/` (#175, 11/09/2026)
 *
 * `RACINES` ne couvrait que `public/vm/` : `public/main.mjs` a atteint 1 022 lignes sans qu'aucun
 * cliquet le voie, et #175 l'a scindé pour cette seule raison. `RACINES` gagne donc `public` ENTIER.
 * Deux familles de fichiers publics ne sont pas du code de produit — `public/coquille-epreuve/` (les
 * topologies hostiles du banc de #166) et `public/spike/` (le banc d'origine de #35, délibérément
 * laissé vivant et inchangé) : elles restent dans le relevé, et n'en sortiraient QUE si le cliquet
 * les rougissait un jour, avec le motif écrit ici même. Ce n'est pas encore le cas.
 *
 * `public/runtime-worker.mjs`, lui, ROUGIT DÉJÀ à 815 lignes — découvert par l'élargissement de
 * `RACINES`, pas causé par lui : c'est le Worker de confiance (#161, ADR 0028), et le scinder est un
 * chantier de sécurité à part entière, hors du périmètre de #175 (qui ne scindait que `main.mjs`).
 * Il est donc HORS PÉRIMÈTRE (voir plus bas), signalé au superviseur, à traiter par une tranche
 * dédiée et relue pour elle-même.
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
const RACINES = ["src", "public"];

/**
 * Fichiers HORS PÉRIMÈTRE du relevé : un chemin ne rejoint cette liste que si l'élargissement d'une
 * racine le fait rougir pour une raison ÉTRANGÈRE à la tranche qui élargit — jamais pour faire
 * passer une scission en cours. Chaque entrée publie la taille du jour et un motif daté : une
 * exclusion n'est pas un silence.
 *
 * @type {{ fichier: string, lignes: number, motif: string }[]}
 */
const HORS_PERIMETRE = [
  {
    fichier: "public/runtime-worker.mjs",
    lignes: 861,
    motif:
      "découvert le 11/09/2026 en élargissant RACINES à `public` (#175) : il dépassait déjà le " +
      "plafond avant cet élargissement, et #175 ne scindait que `main.mjs`. Scinder le Worker de " +
      "confiance (#161, ADR 0028) est un chantier de sécurité distinct, signalé au superviseur ; " +
      "cette exclusion sort de la liste dès qu'une tranche dédiée l'a scindé sous 800 lignes. " +
      "#173 (12/09/2026) y ajoute trente-six lignes — le geste `reprendreLInstallationGeste`, qui " +
      "revérifie la signature d'une installation interrompue avant d'agir — parce qu'il appartient " +
      "au même dispatch que `demarrerLApplication` ; le déplacer seul aurait scindé le fichier sans " +
      "le faire repasser sous le plafond, pour un coût de lisibilité immédiat et un bénéfice différé.",
  },
];

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
    lignes: 800,
    motif:
      "#65 l'avait inscrit à 738 lignes en écrivant « la prochaine tranche qui y touchera devra le " +
      "scinder ». #181 y a touché — l'ouverture décide désormais d'écrire une RACINE INITIALE — et " +
      "l'a scindé : `generation-racine.mjs` emporte l'écrivain de racines et le seul état que le " +
      "protocole ne porte pas, `generation-recuperation.mjs` emporte l'autorisation d'ouvrir sans " +
      "racine et la mise en forme du rapport. Le fichier a fait 805 lignes en chemin ; il en fait " +
      "moins qu'à son inscription en sortant. Ce qui reste est la MACHINE À ÉTATS, et la scinder " +
      "davantage rendrait le protocole illisible pour tenir sous un seuil. La revue de sécurité de " +
      "la PR #184 (constat 9) y ajoute trois lignes : un voisin d'engagement trouvé alors qu'une " +
      "racine fait autorité est ÉCARTÉ et PUBLIÉ, au lieu d'être ignoré en silence. Le geste " +
      "appartient au chemin « une racine décide », donc à cette machine à états. #182 y ajoute trois " +
      "lignes et en retire autant ailleurs : le format écrit suit désormais la version du VOLUME — " +
      "une racine v4 publie deux compteurs — et la reprise des compteurs depuis la racine est " +
      "partie au `Scellement`, qui seul sait combien de clés à compteur il tient. **T2b y ajoute " +
      "trente-huit lignes** : `cloturerParRacine` et `marquerRegionSale`, les deux gestes publics " +
      "que le TROISIÈME chemin hors transaction réclamait (ADR 0033, décision 4). Ils ne peuvent " +
      "pas vivre ailleurs — ils appellent `#vider` et la garde de fraîcheur, qui sont l'état privé " +
      "de cette machine —, et ils n'ouvrent aucun second chemin de scellement. Le fichier reste " +
      "sous le plafond, AU plafond, à zéro ligne près ; la prochaine tranche qui y touchera devra le " +
      "scinder, et la candidate est la RÉCUPÉRATION, qui forme déjà un bloc autonome.",
  },
  {
    fichier: "src/vm/opfs-block-backend.mjs",
    lignes: 796,
    motif:
      "#181 y ajoute UN geste, `empreinteDuFichier`, et il ne peut pas vivre ailleurs : c'est le " +
      "calcul de l'empreinte du fichier ENTIER, fait ICI précisément pour ne pas exposer du " +
      "chiffré. `lireRegionAuth` reste le seul point du dépôt qui rende des octets bruts de " +
      "l'intérieur du fichier, borné à la région ; déplacer le hachage aurait exigé d'ouvrir cette " +
      "porte-là. La revue de format de la PR #186 (constat 2) y ajoute le second point de sortie " +
      "de la même famille, `scellementsCumules` : le versement hors transaction se ferme sans " +
      "écrire de racine, et ce qu'il a consommé sous la clé du volume ne vit que dans ce " +
      "compteur-ci — la datation qui suit doit le recevoir, faute de quoi elle perd la moitié du " +
      "budget de la clé à l'installation. Comme l'empreinte, il ne rend qu'un NOMBRE, jamais des " +
      "octets, et pour la même raison. La datation, elle, est PARTIE : elle vit désormais dans " +
      "`opfs-datation-de-creation.mjs`, et c'est ce qui garde ce fichier sous le plafond. **T2b y " +
      "ajoute le magasin TENU POUR CLORE** (#182) : un second emplacement, distinct de la " +
      "génération installée, une méthode pour l'y poser, la clôture par racine dans `close()` et " +
      "la déclaration de région sale dans l'écriture directe. Les quatre gestes appartiennent au " +
      "cycle de vie du backend, et les déplacer demanderait de sortir `close()` avec eux. La revue " +
      "de sécurité de la PR #187 (constat 3) y ajoute la PUBLICATION qui suit chaque écriture " +
      "directe : une fin d'onglet tue le Worker sans fermeture, et la clôture ne pouvait donc pas " +
      "n'exister qu'en `close()`.",
  },
];

/** Nombre de lignes d'un contenu, tel que `wc -l` le compte. */
function compterLignes(contenu) {
  const lignes = contenu.split("\n");
  return lignes.at(-1) === "" ? lignes.length - 1 : lignes.length;
}

/** Relève tous les modules du périmètre, avec leur taille — HORS_PERIMETRE excepté. */
async function relever() {
  const exclus = new Set(HORS_PERIMETRE.map(({ fichier }) => fichier));
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
      if (exclus.has(fichier)) continue;
      releve.push({ fichier, lignes: compterLignes(await readFile(absolu, "utf8")) });
    }
  }
  return releve.sort((a, b) => b.lignes - a.lignes);
}

/** Relève un fichier HORS_PERIMETRE tel qu'il est aujourd'hui, ou `null` s'il a disparu. */
async function releverUnSeul(fichier) {
  try {
    return compterLignes(await readFile(path.join(REPO_ROOT, fichier), "utf8"));
  } catch {
    return null;
  }
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

test("aucun fichier hors périmètre n'a grandi au-delà de la taille relevée", async () => {
  const debordements = [];
  for (const exclu of HORS_PERIMETRE) {
    const lignes = await releverUnSeul(exclu.fichier);
    if (lignes !== null && lignes > exclu.lignes) {
      debordements.push(`${exclu.fichier} : ${lignes} lignes, exclu à ${exclu.lignes}`);
    }
  }

  assert.deepEqual(
    debordements,
    [],
    "L'exclusion est un cliquet, comme la liste sous surveillance : une revue doit accepter la " +
      "croissance.",
  );
});

test("aucune exclusion hors périmètre n'est périmée", async () => {
  const perimees = [];
  for (const exclu of HORS_PERIMETRE) {
    const lignes = await releverUnSeul(exclu.fichier);
    if (lignes === null || lignes <= PLAFOND) perimees.push(exclu.fichier);
  }

  assert.deepEqual(
    perimees,
    [],
    "Ces fichiers sont repassés sous (ou au) plafond, ou ont disparu : retirez leur exclusion, ils " +
      "rejoignent le relevé normal.",
  );
});
