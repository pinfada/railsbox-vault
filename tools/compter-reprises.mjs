// Compte les épreuves REPRISES et les navigations Firefox RÉCUPÉRÉES d'un rapport Playwright (#178).
//
// Motif : `retries: 2` en CI rendait vert ce qui avait trébuché deux fois, et le rapport `github` ne
// disait pas combien. Depuis l'attribution du défaut à la frontière Playwright ↔ Firefox, la reprise
// globale vaut 0 et seule la signature mesurée est récupérée. Cette récupération doit être COMPTÉE
// elle aussi : le contournement du harnais ne doit jamais se faire passer pour une navigation saine.
//
// L'outil ne juge pas et ne rougit pas : il rend toujours le code 0. La règle et la limite du
// contournement sont écrites dans `docs/testing.md`.
//
// Les TROIS suites du gate rendent chacune leur rapport : l'outil en lit plusieurs, et NOMME la
// suite d'origine de chaque événement — sans cette provenance, il faudrait rouvrir les journaux.
//
// Usage : node tools/compter-reprises.mjs <rapport.json> [autres rapports…]
// Le relevé va sur la sortie standard, et s'ajoute à `$GITHUB_STEP_SUMMARY` quand la variable existe.

import { appendFile, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ANNOTATION_RECUPERATION_FIREFOX } from "../tests/support/navigation-firefox.mjs";

/** Un essai de plus que l'unique essai attendu : voilà ce qu'est une reprise. */
const ESSAIS_SANS_REPRISE = 1;

/** Titre du relevé, le même qu'il compte quelque chose ou qu'il dise n'avoir rien lu. */
const TITRE = "## Stabilité des suites du gate";

/**
 * Parcourt l'arbre des suites d'un rapport Playwright et rend un enregistrement par épreuve JOUÉE.
 * Les suites s'imbriquent (fichier, `describe`), les `specs` portent les `tests`, et un `test` porte
 * un `result` par essai : c'est LUI qui compte les reprises, jamais le statut annoncé.
 *
 * @param {{ suites?: unknown[] }} noeud
 * @param {Array<{ suite: string, fichier: string, ligne: number, titre: string, projet: string, essais: number, statut: string, recuperations: string[] }>} recueil
 * @param {string} suite nom de la suite d'où vient ce rapport
 */
function recueillir(noeud, recueil, suite) {
  for (const sousSuite of noeud?.suites ?? []) {
    for (const spec of sousSuite.specs ?? []) {
      for (const epreuve of spec.tests ?? []) {
        const resultats = epreuve.results ?? [];
        recueil.push({
          suite,
          fichier: spec.file ?? sousSuite.file ?? "fichier inconnu",
          ligne: spec.line ?? 0,
          titre: spec.title ?? "épreuve sans titre",
          projet: epreuve.projectName || "projet sans nom",
          essais: resultats.length,
          statut: epreuve.status ?? "inconnu",
          recuperations: resultats.flatMap((resultat) =>
            (resultat.annotations ?? [])
              .filter((annotation) => annotation.type === ANNOTATION_RECUPERATION_FIREFOX)
              .map((annotation) => annotation.description ?? "sans description"),
          ),
        });
      }
    }
    recueillir(sousSuite, recueil, suite);
  }
  return recueil;
}

/**
 * Lit un rapport JSON et rend ses épreuves. Un rapport illisible LÈVE : c'est une ABSENCE de mesure,
 * jamais un zéro, et l'appelant doit pouvoir le dire — sinon le relevé publierait « aucune reprise »
 * là où rien n'a été lu.
 *
 * Le nom de la SUITE est lu dans le rapport lui-même (`config.rootDir`, donc `tests/<suite>`) et non
 * dans le nom du fichier passé en argument : une étiquette qui viendrait de la ligne de commande
 * pourrait mentir sans que rien ne le voie.
 *
 * @param {string} chemin
 */
export async function lireRapport(chemin) {
  const brut = await readFile(chemin, "utf8");
  const rapport = JSON.parse(brut);
  const racine = rapport?.config?.rootDir;
  // `basename` gère les deux séparateurs et les fins de chemin : `tests/browser`, `tests\browser` et
  // `tests/browser/` rendent tous « browser ». Faute de racine, le nom du fichier fait l'affaire —
  // il vaut mieux une étiquette approximative qu'une colonne vide.
  const suite =
    typeof racine === "string" && racine.length > 0 ? basename(racine) : basename(chemin, ".json");
  return recueillir(rapport, [], suite);
}

/**
 * Rend le relevé d'un ensemble d'épreuves : le total joué, celles qui ont été reprises, et le nombre
 * d'essais que la reprise a coûtés. Une épreuve rouge après toutes ses reprises reste comptée : elle
 * a bien été reprise, et le cacher serait le défaut que cet outil corrige.
 *
 * @param {Array<{ essais: number }>} epreuves
 */
export function releverReprises(epreuves) {
  const reprises = epreuves
    .filter((epreuve) => epreuve.essais > ESSAIS_SANS_REPRISE)
    .sort(
      (a, b) =>
        b.essais - a.essais ||
        a.suite.localeCompare(b.suite) ||
        a.fichier.localeCompare(b.fichier) ||
        a.ligne - b.ligne,
    );
  return {
    jouees: epreuves.length,
    reprises,
    recuperations: epreuves.flatMap((epreuve) =>
      (epreuve.recuperations ?? []).map((description) => ({ ...epreuve, description })),
    ),
    essaisSupplementaires: reprises.reduce(
      (total, epreuve) => total + epreuve.essais - ESSAIS_SANS_REPRISE,
      0,
    ),
  };
}

/** Dit en clair ce qu'une épreuve reprise a fini par rendre. Jamais « passed » tout court. */
function issue(epreuve) {
  if (epreuve.statut === "flaky") return `verte au ${epreuve.essais}ᵉ essai`;
  if (epreuve.statut === "expected") return "verte";
  if (epreuve.statut === "unexpected") return `ROUGE après ${epreuve.essais} essais`;
  return epreuve.statut;
}

/**
 * Met le relevé en Markdown, lisible dans le résumé d'un job GitHub. Le texte nomme la règle : une
 * épreuve reprise n'est pas verte, elle est tolérée.
 *
 * @param {ReturnType<typeof releverReprises>} releve
 */
export function enMarkdown(releve) {
  const lignes = [TITRE, ""];
  // Les suites TOUCHÉES, nommées en tête : « six reprises » ne dit pas si le gate a trébuché dans la
  // suite navigateur, qui les tolère, ou dans une autre — et ce n'est pas la même nouvelle.
  const suites = [...new Set(releve.reprises.map((epreuve) => epreuve.suite))].sort();
  if (releve.reprises.length === 0) {
    lignes.push(
      `Aucune épreuve reprise : les ${releve.jouees} épreuves ont été jouées une seule fois.`,
      "",
    );
    lignes.push("### Navigations Firefox récupérées", "");
  } else {
    lignes.push(
      `**${releve.reprises.length} épreuve(s) reprise(s)** sur ${releve.jouees} jouée(s), ` +
        `pour ${releve.essaisSupplementaires} essai(s) supplémentaire(s). ` +
        `Suite(s) touchée(s) : ${suites.join(", ")}. ` +
        "Une épreuve reprise n'est pas verte : elle est tolérée (`docs/testing.md`).",
      "",
      "| Suite | Épreuve | Projet (moteur) | Essais | Issue |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const epreuve of releve.reprises) {
      lignes.push(
        `| ${epreuve.suite} | \`${epreuve.fichier}:${epreuve.ligne}\` — ${epreuve.titre} | ${epreuve.projet} | ${epreuve.essais} | ${issue(epreuve)} |`,
      );
    }
    lignes.push("", "### Navigations Firefox récupérées", "");
  }

  if (releve.recuperations.length === 0) {
    lignes.push("Aucune navigation Firefox récupérée.", "");
    return lignes.join("\n");
  }
  lignes.push(
    `**${releve.recuperations.length} navigation(s) Firefox récupérée(s).** ` +
      "Le document était complet, mais `page.goto` ne répondait plus ; aucune épreuve n'a été rejouée.",
    "",
    "| Suite | Épreuve | Projet | Diagnostic |",
    "| --- | --- | --- | --- |",
  );
  for (const recuperation of releve.recuperations) {
    lignes.push(
      `| ${recuperation.suite} | \`${recuperation.fichier}:${recuperation.ligne}\` — ${recuperation.titre} | ${recuperation.projet} | ${recuperation.description} |`,
    );
  }
  lignes.push("");
  return lignes.join("\n");
}

/**
 * Compose le relevé publiable à partir des épreuves lues et des rapports qui ne l'ont pas été.
 *
 * Quand AUCUN rapport n'a été lu, le relevé ne prétend même pas compter : il dit qu'il n'a rien
 * mesuré. Publier « aucune reprise » là où rien n'a été lu serait le défaut que cet outil corrige,
 * déplacé d'un cran.
 *
 * @param {Array<{ essais: number }>} epreuves
 * @param {string[]} absents descriptions des rapports non lus
 */
export function composerReleve(epreuves, absents) {
  let texte =
    epreuves.length === 0 && absents.length > 0
      ? `${TITRE}\n\nAucun rapport lu : le compte des reprises n'a PAS été mesuré.\n`
      : enMarkdown(releverReprises(epreuves));
  if (absents.length > 0) {
    texte += `\nRapport(s) non lu(s), donc non comptés :\n${absents.map((a) => `- ${a}`).join("\n")}\n`;
  }
  return texte;
}

async function principal(chemins) {
  if (chemins.length === 0) {
    process.stderr.write("Usage : node tools/compter-reprises.mjs <rapport.json> […]\n");
    return;
  }
  const epreuves = [];
  const absents = [];
  for (const chemin of chemins) {
    try {
      epreuves.push(...(await lireRapport(chemin)));
    } catch (erreur) {
      absents.push(`${chemin} : ${erreur.message}`);
    }
  }

  const texte = composerReleve(epreuves, absents);
  process.stdout.write(`${texte}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${texte}\n`, "utf8");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await principal(process.argv.slice(2));
}
