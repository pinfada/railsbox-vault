#!/usr/bin/env node
// LE LANCEUR des onze campagnes de mutation (#196) : il les rejoue en SÉQUENCE, s'arrête au premier
// code de sortie non nul, et publie une table (campagne, mutants, tués, survivants, durée).
//
//     npm run check:mutations
//     node tools/rejouer-les-campagnes.mjs
//
// ## Pourquoi la SÉQUENCE, et pas le parallèle
//
// Chaque `tools/muter-gardes-*.mjs` recopie déjà le dépôt entier (`src`, `tests`, `tools`, `public`,
// `package.json`) dans un atelier temporaire et le détruit à la fin de SA campagne
// (`tools/moteur-de-mutation.mjs`) ; à l'intérieur, chaque mutant rejoue `node --test` avec un tas
// plafonné à 512 Mo. Mesuré le 12 septembre 2026 sur ce poste : les onze campagnes tiennent en
// **environ 5 min 30 s au total**, un atelier à la fois. Onze copies SIMULTANÉES multiplieraient le
// coût disque et mémoire par onze sans qu'aucune mesure n'ait montré qu'un exécutant CI partagé
// l'absorbe — c'est justement la condition que le superviseur a posée avant tout parallélisme. La
// séquence est le choix mesuré, pas un raccourci.
//
// ## Ce que « échouer » veut dire ici
//
// Le premier code de sortie non nul ARRÊTE la boucle : les campagnes suivantes ne sont pas jouées.
// Ce n'est pas une économie de temps — c'est qu'un survivant est un trou de preuve, et qu'empiler des
// campagnes vertes derrière ne le comble pas. La table publiée montre alors où la séquence s'est
// arrêtée, jamais un total qui prétendrait avoir tout mesuré.

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("..", import.meta.url));

/**
 * Les onze campagnes, dans l'ordre où elles sont jouées. Ajouter une douzième campagne, c'est ajouter
 * une ligne ici — le lanceur ne connaît rien d'autre du contrat que le nom du script et `--json`.
 */
export const CAMPAGNES = Object.freeze([
  { nom: "archive-recuperation", script: "tools/muter-gardes-archive-recuperation.mjs" },
  { nom: "coquille", script: "tools/muter-gardes-coquille.mjs" },
  { nom: "cycle-de-vie", script: "tools/muter-gardes-cycle-de-vie.mjs" },
  { nom: "enveloppe-v2", script: "tools/muter-gardes-enveloppe-v2.mjs" },
  { nom: "fins-d-onglet", script: "tools/muter-gardes-fins-d-onglet.mjs" },
  { nom: "hierarchie-de-cles", script: "tools/muter-gardes-hierarchie-de-cles.mjs" },
  { nom: "instantane", script: "tools/muter-gardes-instantane.mjs" },
  { nom: "persistance", script: "tools/muter-gardes-persistance.mjs" },
  { nom: "recuperation", script: "tools/muter-gardes-recuperation.mjs" },
  { nom: "revocation-urgence", script: "tools/muter-gardes-revocation-urgence.mjs" },
  { nom: "verrouillage", script: "tools/muter-gardes-verrouillage.mjs" },
]);

const RAPPORT_JSON = "reports/mutations.json";

/**
 * Joue une campagne dans un enfant séparé et rend son verdict.
 *
 * `--json` fait écrire au script appelé EXACTEMENT `{ resultats }` sur sa sortie standard, sans
 * aucune autre ligne — c'est le contrat partagé des onze scripts, posé par `tools/moteur-de-mutation.mjs`
 * et sa fonction `campagneDeMutation`. Un code de sortie qui n'est ni 0 ni 1 n'est pas un verdict :
 * l'enfant s'est arrêté (signal, crash) avant d'en rendre un, et c'est nommé comme tel plutôt que
 * deviné.
 */
function jouer(campagne) {
  const debut = Date.now();
  const resultat = spawnSync(process.execPath, [campagne.script, "--json"], {
    cwd: RACINE,
    encoding: "utf8",
  });
  const dureeMs = Date.now() - debut;

  if (resultat.status !== 0 && resultat.status !== 1) {
    return {
      ...campagne,
      ok: false,
      dureeMs,
      erreur: `code de sortie inattendu (${resultat.status ?? `signal ${resultat.signal}`}) : ${(resultat.stderr || resultat.stdout || "").slice(0, 500)}`,
    };
  }

  let resultats;
  try {
    ({ resultats } = JSON.parse(resultat.stdout));
  } catch (erreur) {
    return { ...campagne, ok: false, dureeMs, erreur: `sortie JSON illisible : ${erreur.message}` };
  }

  const tues = resultats.filter((r) => r.tue).length;
  return {
    ...campagne,
    ok: resultat.status === 0,
    dureeMs,
    mutants: resultats.length,
    tues,
    survivants: resultats.length - tues,
    survivantsDetail: resultats.filter((r) => !r.tue),
  };
}

function formaterDuree(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Met la table en Markdown, lisible dans le résumé d'un job GitHub comme sur un terminal. */
export function enMarkdown(lignes, dureeTotaleMs, arreteA) {
  const entetes = ["Campagne", "Mutants", "Tués", "Survivants", "Durée"];
  const rangees = lignes.map((ligne) => [
    ligne.nom,
    ligne.mutants ?? "—",
    ligne.tues ?? "—",
    ligne.survivants ?? "—",
    formaterDuree(ligne.dureeMs),
  ]);
  const corps = [
    `| ${entetes.join(" | ")} |`,
    `| ${entetes.map(() => "---").join(" | ")} |`,
    ...rangees.map((rangee) => `| ${rangee.join(" | ")} |`),
  ];
  const bilan = arreteA
    ? `**Arrêtée au premier échec : \`${arreteA}\`.** Les campagnes suivantes n'ont pas été jouées.`
    : `**${lignes.reduce((s, l) => s + l.tues, 0)}/${lignes.reduce((s, l) => s + l.mutants, 0)} mutants tués sur les onze campagnes, ${formaterDuree(dureeTotaleMs)} au total.**`;
  return ["## Campagnes de mutation", "", ...corps, "", bilan, ""].join("\n");
}

async function principal() {
  const debutTotal = Date.now();
  const lignes = [];
  let arreteA = null;
  for (const campagne of CAMPAGNES) {
    const ligne = jouer(campagne);
    lignes.push(ligne);
    if (!ligne.ok) {
      arreteA = campagne.nom;
      break;
    }
  }
  const dureeTotaleMs = Date.now() - debutTotal;

  for (const ligne of lignes) {
    if (ligne.ok) {
      process.stdout.write(
        `[OK]    ${ligne.nom} — ${ligne.tues}/${ligne.mutants} mutants tués (${formaterDuree(ligne.dureeMs)})\n`,
      );
      continue;
    }
    process.stdout.write(`[ÉCHEC] ${ligne.nom} (${formaterDuree(ligne.dureeMs)})\n`);
    if (ligne.erreur) process.stdout.write(`        ${ligne.erreur}\n`);
    for (const survivant of ligne.survivantsDetail ?? []) {
      process.stdout.write(`        SURVIVANT : ${survivant.nom} — ${survivant.garde}\n`);
      if (survivant.raison) process.stdout.write(`          ${survivant.raison}\n`);
    }
  }

  const texte = enMarkdown(lignes, dureeTotaleMs, arreteA);
  process.stdout.write(`\n${texte}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, texte, "utf8");
  }

  const cheminRapport = resolve(RACINE, RAPPORT_JSON);
  await mkdir(dirname(cheminRapport), { recursive: true });
  await writeFile(
    cheminRapport,
    JSON.stringify(
      {
        horodatage: new Date().toISOString(),
        dureeTotaleMs,
        ok: arreteA === null,
        campagnes: lignes,
      },
      null,
      2,
    ),
    "utf8",
  );

  process.exitCode = arreteA === null ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await principal();
}
