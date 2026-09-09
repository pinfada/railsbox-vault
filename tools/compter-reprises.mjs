// Compte les épreuves REPRISES d'un rapport JSON de Playwright et publie le relevé (#178).
//
// Motif : `retries: 2` en CI rend vert ce qui a trébuché deux fois, et le rapport `github` ne dit
// pas combien. Trois passages de `npm run check` en local perdaient une épreuve Firefox chacun sans
// que la CI ne montre rien ; le run 34330037820 a repris HUIT épreuves, chacune trois fois, pour
// annoncer « 280 passed ». Une épreuve reprise n'est pas verte : elle est TOLÉRÉE, et le prix de
// la tolérance est qu'elle soit COMPTÉE à chaque run, sous les yeux de qui fusionne.
//
// L'outil ne juge pas et ne rougit pas : il rend toujours le code 0. Bloquer une fusion sur un
// flottement non attribué punirait les tranches pour un défaut du harnais ; le compte publié suffit
// à ne pas le cacher. La règle est écrite dans `docs/testing.md`.
//
// Usage : node tools/compter-reprises.mjs <rapport.json> [autres rapports…]
// Le relevé va sur la sortie standard, et s'ajoute à `$GITHUB_STEP_SUMMARY` quand la variable existe.

import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Un essai de plus que l'unique essai attendu : voilà ce qu'est une reprise. */
const ESSAIS_SANS_REPRISE = 1;

/**
 * Parcourt l'arbre des suites d'un rapport Playwright et rend un enregistrement par épreuve JOUÉE.
 * Les suites s'imbriquent (fichier, `describe`), les `specs` portent les `tests`, et un `test` porte
 * un `result` par essai : c'est LUI qui compte les reprises, jamais le statut annoncé.
 *
 * @param {{ suites?: unknown[] }} noeud
 * @param {Array<{ fichier: string, ligne: number, titre: string, projet: string, essais: number, statut: string }>} recueil
 */
function recueillir(noeud, recueil) {
  for (const suite of noeud?.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const epreuve of spec.tests ?? []) {
        recueil.push({
          fichier: spec.file ?? suite.file ?? "fichier inconnu",
          ligne: spec.line ?? 0,
          titre: spec.title ?? "épreuve sans titre",
          projet: epreuve.projectName ?? "projet inconnu",
          essais: (epreuve.results ?? []).length,
          statut: epreuve.status ?? "inconnu",
        });
      }
    }
    recueillir(suite, recueil);
  }
  return recueil;
}

/**
 * Lit un rapport JSON et rend ses épreuves. Un rapport illisible est une ABSENCE de mesure, jamais
 * un zéro : l'appelant doit pouvoir le dire, sinon le relevé publierait « aucune reprise » là où
 * rien n'a été lu.
 *
 * @param {string} chemin
 */
export async function lireRapport(chemin) {
  const brut = await readFile(chemin, "utf8");
  const rapport = JSON.parse(brut);
  return recueillir(rapport, []);
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
    .sort((a, b) => b.essais - a.essais || a.fichier.localeCompare(b.fichier) || a.ligne - b.ligne);
  return {
    jouees: epreuves.length,
    reprises,
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
  const lignes = ["## Épreuves reprises — suite navigateur", ""];
  if (releve.reprises.length === 0) {
    lignes.push(
      `Aucune épreuve reprise : les ${releve.jouees} épreuves ont été jouées une seule fois.`,
      "",
    );
    return lignes.join("\n");
  }
  lignes.push(
    `**${releve.reprises.length} épreuve(s) reprise(s)** sur ${releve.jouees} jouée(s), ` +
      `pour ${releve.essaisSupplementaires} essai(s) supplémentaire(s). ` +
      "Une épreuve reprise n'est pas verte : elle est tolérée (`docs/testing.md`).",
    "",
    "| Épreuve | Projet (moteur) | Essais | Issue |",
    "| --- | --- | --- | --- |",
  );
  for (const epreuve of releve.reprises) {
    lignes.push(
      `| \`${epreuve.fichier}:${epreuve.ligne}\` — ${epreuve.titre} | ${epreuve.projet} | ${epreuve.essais} | ${issue(epreuve)} |`,
    );
  }
  lignes.push("");
  return lignes.join("\n");
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

  let texte = enMarkdown(releverReprises(epreuves));
  if (absents.length > 0) {
    // Un rapport manquant n'est pas zéro reprise : le relevé le DIT, sinon il mentirait par silence.
    texte += `\nRapport(s) non lu(s), donc non comptés :\n${absents.map((a) => `- ${a}`).join("\n")}\n`;
  }

  process.stdout.write(`${texte}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${texte}\n`, "utf8");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await principal(process.argv.slice(2));
}
