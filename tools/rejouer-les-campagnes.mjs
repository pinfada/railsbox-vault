#!/usr/bin/env node
// LE LANCEUR des seize campagnes de mutation (#196) : il les rejoue en SÉQUENCE, s'arrête au premier
// code de sortie non nul, et publie une table (campagne, mutants, tués, survivants, durée).
//
//     npm run check:mutations                          # TOUT, en séquence (poste de développement)
//     npm run check:mutations -- --lot=2               # le lot 2 de `LOTS` (un job CI de la matrice)
//     npm run check:mutations -- --campagnes=magasin,coquille@1/4
//
// ## Les LOTS (#328)
//
// La séquence complète a tenu 859 s sur la PR #323 et a été annulée au plafond de 15 min sur `main` :
// elle est découpée en `LOTS`, joués en PARALLÈLE par la matrice de `ci.yml`, un atelier temporaire
// par job. Une campagne peut elle-même être coupée en tranches `nom@i/n` (`coquille` seule a tenu
// 492 s, plus que la moitié du plafond). Chaque campagne, et chaque tranche, figure exactement une
// fois dans `LOTS` — `tests/unit/campagnes-de-mutation-repartition.test.mjs` le garde.
//
// ## Pourquoi la SÉQUENCE DANS un lot, et le parallèle seulement ENTRE jobs
//
// (#328 : le parallélisme est celui des jobs CI, chacun sur son propre exécutant et son propre disque ;
// à l'intérieur d'un processus du lanceur, la séquence ci-dessous reste le choix mesuré.)
//
// Chaque `tools/muter-gardes-*.mjs` recopie déjà le dépôt entier (`src`, `tests`, `tools`, `public`,
// `package.json`) dans un atelier temporaire et le détruit à la fin de SA campagne
// (`tools/moteur-de-mutation.mjs`) ; à l'intérieur, chaque mutant rejoue `node --test` avec un tas
// plafonné à 512 Mo. Mesuré le 12 septembre 2026 sur ce poste : les onze campagnes tenaient en
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
 * Les seize campagnes, dans l'ordre où elles sont jouées. Ajouter une campagne, c'est ajouter
 * une ligne ici ET la placer dans un lot de `LOTS` — le lanceur ne connaît rien d'autre du contrat que le nom du script et `--json`.
 */
export const CAMPAGNES = Object.freeze([
  { nom: "archive-recuperation", script: "tools/muter-gardes-archive-recuperation.mjs" },
  { nom: "coquille", script: "tools/muter-gardes-coquille.mjs" },
  { nom: "cycle-de-vie", script: "tools/muter-gardes-cycle-de-vie.mjs" },
  { nom: "dephasage", script: "tools/muter-gardes-dephasage.mjs" },
  { nom: "enveloppe-v2", script: "tools/muter-gardes-enveloppe-v2.mjs" },
  { nom: "fins-d-onglet", script: "tools/muter-gardes-fins-d-onglet.mjs" },
  { nom: "hierarchie-de-cles", script: "tools/muter-gardes-hierarchie-de-cles.mjs" },
  { nom: "hors-ligne", script: "tools/muter-gardes-hors-ligne.mjs" },
  { nom: "instantane", script: "tools/muter-gardes-instantane.mjs" },
  { nom: "magasin", script: "tools/muter-gardes-magasin.mjs" },
  { nom: "paquet-applicatif", script: "tools/muter-gardes-paquet-applicatif.mjs" },
  { nom: "persistance", script: "tools/muter-gardes-persistance.mjs" },
  { nom: "recuperation", script: "tools/muter-gardes-recuperation.mjs" },
  { nom: "reserve", script: "tools/muter-gardes-reserve.mjs" },
  { nom: "revocation-urgence", script: "tools/muter-gardes-revocation-urgence.mjs" },
  { nom: "verrouillage", script: "tools/muter-gardes-verrouillage.mjs" },
]);

/**
 * Les lots de la CI, répartis d'après les durées MESURÉES sur la PR #323 (run 45771991219, 859 s au
 * total) : `coquille` 492 s en quatre tranches de ≈ 123 s, `reserve` 105 s, `magasin` 83 s,
 * `hors-ligne` 49 s, le reste 1 à 23 s. Chaque lot pèse ≈ 190 à 235 s, soit moins de la moitié
 * (450 s) du plafond de 15 min d'un job, avant le coût d'installation.
 * Une entrée est `nom` (toute la campagne) ou `nom@i/n` (la tranche i d'une table coupée en n).
 */
export const LOTS = Object.freeze([
  Object.freeze(["coquille@1/4", "magasin"]),
  Object.freeze(["coquille@2/4", "reserve"]),
  Object.freeze([
    "coquille@3/4",
    "hors-ligne",
    "recuperation",
    "cycle-de-vie",
    "archive-recuperation",
  ]),
  Object.freeze([
    "coquille@4/4",
    "dephasage",
    "enveloppe-v2",
    "fins-d-onglet",
    "hierarchie-de-cles",
    "instantane",
    "paquet-applicatif",
    "persistance",
    "revocation-urgence",
    "verrouillage",
  ]),
]);

/** Résout une entrée `nom` ou `nom@i/n` en campagne, avec sa tranche éventuelle. */
function resoudre(entree) {
  const [nom, tranche] = entree.split("@");
  const campagne = CAMPAGNES.find((c) => c.nom === nom);
  if (!campagne) throw new Error(`campagne inconnue : « ${nom} ».`);
  return tranche === undefined ? { ...campagne } : { ...campagne, tranche };
}

/**
 * Ce que le lanceur doit jouer. Sans argument : TOUTES les campagnes, en entier. `lot` (1..N) : les
 * entrées de `LOTS[lot-1]`. `campagnes` : une liste séparée par des virgules. Les deux ensemble, un
 * numéro de lot hors bornes ou un nom inconnu sont refusés — jamais une sélection vide silencieuse.
 */
export function selectionner({ lot, campagnes }) {
  if (lot !== undefined && campagnes !== undefined) {
    throw new Error("--lot et --campagnes s'excluent : choisir l'un des deux.");
  }
  if (lot !== undefined) {
    const numero = Number(lot);
    if (!Number.isInteger(numero) || numero < 1 || numero > LOTS.length) {
      throw new Error(`lot « ${lot} » invalide : attendu un entier de 1 à ${LOTS.length}.`);
    }
    return LOTS[numero - 1].map(resoudre);
  }
  if (campagnes !== undefined) {
    const noms = campagnes
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (noms.length === 0) throw new Error("--campagnes est vide : aucune campagne à jouer.");
    return noms.map(resoudre);
  }
  return CAMPAGNES.map((c) => ({ ...c }));
}

/** Lit `--lot=N`, `--campagnes=a,b` et `--rapport=chemin` ; tout autre argument est refusé. */
function lireArguments(argv) {
  const lus = {};
  for (const argument of argv) {
    const m = /^--(lot|campagnes|rapport)=(.+)$/u.exec(argument);
    if (!m) throw new Error(`argument inconnu : « ${argument} ».`);
    lus[m[1]] = m[2];
  }
  return lus;
}

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
  const environnement = { ...process.env };
  delete environnement.VAULT_MUTATION_TRANCHE;
  if (campagne.tranche) environnement.VAULT_MUTATION_TRANCHE = campagne.tranche;
  const resultat = spawnSync(process.execPath, [campagne.script, "--json"], {
    cwd: RACINE,
    encoding: "utf8",
    env: environnement,
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

  if (resultats.length === 0) {
    return { ...campagne, ok: false, dureeMs, erreur: "campagne vide : 0 mutant éprouvé." };
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
    ligne.tranche ? `${ligne.nom}@${ligne.tranche}` : ligne.nom,
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
    : `**${lignes.reduce((s, l) => s + l.tues, 0)}/${lignes.reduce((s, l) => s + l.mutants, 0)} mutants tués sur ${lignes.length} campagnes ou tranches, ${formaterDuree(dureeTotaleMs)} au total.**`;
  return ["## Campagnes de mutation", "", ...corps, "", bilan, ""].join("\n");
}

async function principal() {
  const { rapport, ...selection } = lireArguments(process.argv.slice(2));
  const aJouer = selectionner(selection);
  const debutTotal = Date.now();
  const lignes = [];
  let arreteA = null;
  for (const campagne of aJouer) {
    const ligne = jouer(campagne);
    lignes.push(ligne);
    if (!ligne.ok) {
      arreteA = campagne.tranche ? `${campagne.nom}@${campagne.tranche}` : campagne.nom;
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

  const cheminRapport = resolve(RACINE, rapport ?? RAPPORT_JSON);
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
