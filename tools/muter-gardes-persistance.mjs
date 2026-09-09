#!/usr/bin/env node
// CAMPAGNE DE MUTATION de la BORNE DE PERSISTANCE (#168, ADR 0006).
//
//     node tools/muter-gardes-persistance.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les campagnes précédentes :
// recopie du dépôt dans un atelier temporaire, épreuve jouée SANS mutation d'abord, `node --check`
// sur le fichier muté, arrêt sans verdict compté NON CONCLUANT. Ce fichier ne tient que sa TABLE.
//
// ## Ce que la campagne mesure
//
// Sous Firefox, `navigator.storage.persist()` ne rend RIEN — mesuré le 9 septembre 2026, dix essais,
// promesse toujours pendante au-delà de quinze secondes, avec ou sans geste utilisateur préalable.
// Les bancs de budget et de conduite y restaient bloqués jusqu'au délai d'épreuve. La borne pose
// quatre secondes et rend l'état `pending`, que la conduite traduit en `ATTENTE_RESOLUTION`.
//
// Quatre gardes tiennent cette conduite, et une suite verte ne prouve pas qu'elles tiennent : elle
// prouve qu'elles n'ont pas encore été retirées. La campagne les retire.
//
// ## Ce que la campagne ne peut PAS mesurer
//
// Elle ne mesure pas ce que le MOTEUR fait de l'invite : que Firefox laisse la promesse pendante,
// que la préférence d'essai la tranche, que WebKit n'expose pas l'API. Cela relève de la famille de
// projets `persistance-*` de `playwright.config.mjs`, dont le relevé est publié dans
// `docs/compatibility.md` avec sa date.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const BUDGET = "src/vm/storage-budget.mjs";
const CONDUITE = "src/vm/persistence-conduct.mjs";

const EPREUVE_BUDGET = "tests/unit/vm-storage-budget.test.mjs";
const EPREUVE_CONDUITE = "tests/unit/vm-persistence-conduct.test.mjs";

/**
 * Les gardes de #168, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "la BORNE existe : `persist()` n'est jamais attendu nu",
    garde: "demanderPersistance — `opposerUnDelai` autour de la promesse du moteur",
    fichier: BUDGET,
    avant: "    granted = (await opposerUnDelai(persist(), delaiDeDecisionMs)) === true;",
    apres: "    granted = (await persist()) === true;",
    epreuves: [EPREUVE_BUDGET],
  },
  {
    nom: "une décision NON RENDUE n'est pas rangée avec les refus",
    garde: "demanderPersistance — la branche `DecisionNonRendue` qui rend `pending`",
    fichier: BUDGET,
    avant:
      '      return { operation: "persist", state: "pending", durable: false, diagnostic: null };',
    apres:
      '      return { operation: "persist", state: "denied", durable: false, diagnostic: null };',
    epreuves: [EPREUVE_BUDGET],
  },
  {
    nom: "le DÉLAI est respecté : une décision rendue à temps n'est pas requalifiée en attente",
    garde: "demanderPersistance — le délai passé à `opposerUnDelai`, et non zéro",
    fichier: BUDGET,
    avant: "    granted = (await opposerUnDelai(persist(), delaiDeDecisionMs)) === true;",
    apres: "    granted = (await opposerUnDelai(persist(), 0)) === true;",
    epreuves: [EPREUVE_BUDGET],
  },
  {
    nom: "l'attente HALTE la conduite au lieu de la trancher en volatile",
    garde: "chooseShellState — la branche `pending` qui rend `ATTENTE_RESOLUTION`",
    fichier: CONDUITE,
    avant: "    return SHELL_STATES.awaitingResolution;\n",
    apres: "",
    epreuves: [EPREUVE_CONDUITE],
  },
]);

function rapporter({ resultats }, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ resultats }, null, 2)}\n`);
    return resultats;
  }
  for (const resultat of resultats) {
    const verdict = resultat.tue ? "TUÉ" : resultat.applicable ? "SURVIVANT" : "NON APPLICABLE";
    process.stdout.write(`[${verdict}] ${resultat.nom}\n        garde : ${resultat.garde}\n`);
    if (resultat.raison) process.stdout.write(`        ${resultat.raison}\n`);
  }
  const tues = resultats.filter(({ tue }) => tue).length;
  process.stdout.write(`\n${tues}/${resultats.length} mutants tués.\n`);
  return resultats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultats = rapporter(
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "persistance" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
