#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du cycle de vie assemblé (#163, ADR 0030).
//
//     node tools/muter-gardes-cycle-de-vie.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les quatre campagnes
// précédentes : recopie du dépôt dans un atelier temporaire, `NODE_TEST_CONTEXT` retiré de
// l'enfant, épreuve jouée SANS mutation d'abord, `node --check` sur le fichier muté, arrêt sans
// verdict compté NON CONCLUANT. Ce fichier ne tient que sa TABLE.
//
// ## Pourquoi ces gardes-là, et pas celles de la page
//
// Le même partage que pour #161 : les gardes du cycle sont des FONCTIONS PURES de `src/coquille/`,
// et la page comme le Worker ne font que les appeler. Une garde écrite dans `public/main.mjs` ne
// serait éprouvable que par un navigateur, donc jamais par un enfant borné — et une garde qu'aucune
// mutation ne peut atteindre est une garde qu'on croit sur parole.
//
// C'est pour cela que le constat d'exclusivité reçoit ses primitives de support en paramètre, et que
// la lecture du descripteur reçoit son `fetch` : sans cette injection, deux décisions de cette
// tranche seraient hors de portée de toute campagne.
//
// ## Ce que la campagne ne peut PAS mesurer, et il faut le dire
//
// Elle ne mesure pas ce que le NAVIGATEUR fait de ces décisions : qu'un Worker qui jette livre bien
// un événement `error`, qu'une borne de trente secondes expire, que `Cross-Origin-Opener-Policy`
// coupe une relation d'ouverture, que Rails boote sur un volume OPFS. Cela relève de
// `tests/browser/coquille-cycle-de-vie.spec.mjs` et `tests/browser/entetes-durcissement.spec.mjs`
// sur les trois moteurs, et de `tests/e2e/reprise-coquille-boot-froid.spec.mjs` en intégration
// continue. Les deux se complètent : la campagne dit que la décision sait rougir, le navigateur dit
// qu'elle porte sur quelque chose.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const CYCLE = "src/coquille/cycle-de-vie.mjs";
const MORT = "src/coquille/mort-du-worker.mjs";
const CAPACITES = "src/coquille/capacites-de-la-coquille.mjs";
const EXCLUSIVITE = "src/coquille/exclusivite-du-volume.mjs";
const APPLICATION = "src/coquille/application-de-reference.mjs";

const EPREUVE_CYCLE = "tests/unit/coquille-cycle-de-vie.test.mjs";
const EPREUVE_APPLICATION = "tests/unit/coquille-application.test.mjs";

/**
 * Les gardes de #163, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "une étape inconnue du cycle est refusée plutôt qu'inscrite",
    garde: "exigerLOrdre — la table des étapes connues",
    fichier: CYCLE,
    avant:
      "  if (rang === undefined) {\n" +
      "    throw refus(\n" +
      "      CODES_REFUS_COQUILLE.etapeHorsOrdre,\n" +
      "      `Étape inconnue du cycle de vie : ${String(etape)}.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "une issue hors de la table est refusée : « conclue » n'est pas un mot libre",
    garde: "exigerLOrdre — la table des issues",
    fichier: CYCLE,
    avant:
      "  if (!ISSUES_CONNUES.has(issue)) {\n" +
      "    throw refus(\n" +
      "      CODES_REFUS_COQUILLE.etapeHorsOrdre,\n" +
      "      `Issue inconnue pour l'étape « ${etape} » : ${String(issue)}.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "une étape conclue DEUX fois est refusée : le journal est une suite, pas un état",
    garde: "exigerLOrdre — l'unicité d'une étape",
    fichier: CYCLE,
    avant:
      "  if (parEtape.has(etape)) {\n" +
      "    throw refus(\n" +
      "      CODES_REFUS_COQUILLE.etapeHorsOrdre,\n" +
      "      `L'étape « ${etape} » est déjà conclue : le journal est une suite, pas un état.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "une étape demandée AVANT celle dont elle dépend est refusée",
    garde: "exigerLOrdre — la boucle sur les étapes antérieures, c'est-à-dire L'ORDRE",
    fichier: CYCLE,
    avant:
      "  for (let anterieur = 0; anterieur < rang; anterieur += 1) {\n" +
      "    const attendue = ETAPES_DU_CYCLE[anterieur];\n" +
      "    if (parEtape.has(attendue)) continue;\n" +
      "    throw refus(\n" +
      "      CODES_REFUS_COQUILLE.etapeHorsOrdre,\n" +
      "      `L'étape « ${etape} » a été demandée avant « ${attendue} », dont elle dépend.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "la VM démarre APRÈS le backend, et pas avant",
    garde: "exigerLeBackend — l'exigence d'un volume OUVERT",
    fichier: CYCLE,
    avant: "  if (etatDuVolume === ETATS_DU_VOLUME.ouvert) return;\n",
    apres: "  return;\n",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "le cadre n'est créé qu'une fois l'étape du backend et de la VM conclue",
    garde: "peutEncadrer — la condition sur l'étape 3",
    fichier: CYCLE,
    avant: '    peutEncadrer: () => parEtape.has("backendPuisVm"),',
    apres: "    peutEncadrer: () => true,",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "une cause hors table est refusée : on ne constate pas une mort par défaut",
    garde: "conduiteApresLaMort — la table des causes",
    fichier: MORT,
    avant:
      "  if (!CAUSES_CONNUES.has(cause)) {\n" +
      "    throw new Error(\n" +
      "      `Cause de mort inconnue : ${String(cause)}. La coquille ne constate pas une mort par défaut.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "un moteur INDISPONIBLE reste indisponible : la mort ne lui invente pas un verrou",
    garde: "conduiteApresLaMort — la préservation de l'état « indisponible »",
    fichier: MORT,
    avant:
      "  const etat =\n" +
      "    etatConnu === ETATS_DU_VOLUME.indisponible\n" +
      "      ? ETATS_DU_VOLUME.indisponible\n" +
      "      : ETATS_DU_VOLUME.verrouille;",
    apres: "  const etat = ETATS_DU_VOLUME.verrouille;",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "le refus d'un Worker mort porte SON code, et non celui d'un type inconnu",
    garde: "conduiteApresLaMort — le code rendu",
    fichier: MORT,
    avant: "    code: CODES_REFUS_COQUILLE.workerMort,",
    apres: "    code: CODES_REFUS_COQUILLE.typeInconnu,",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "`estUneMortDuWorker` ne reconnaît QUE le refus qu'elle a posé",
    garde: "estUneMortDuWorker — la comparaison de code",
    fichier: MORT,
    avant: "  return erreur?.code === CODES_REFUS_COQUILLE.workerMort;",
    apres: "  return erreur?.code !== undefined;",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "une capacité EXIGÉE absente rend la coquille insuffisante",
    garde: "mesurerLesCapacites — le filtre des capacités exigées",
    fichier: CAPACITES,
    avant: "    suffisante: manquantes.every((nom) => !exigees.has(nom)),",
    apres: "    suffisante: true,",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "une sonde de capacité qui LÈVE rend « absente », et non une exception",
    garde: "mesurerLesCapacites — le try/catch autour de chaque sonde",
    fichier: CAPACITES,
    avant:
      "    let vue;\n" +
      "    try {\n" +
      "      vue = capacite.presente(portee) === true;\n" +
      "    } catch {\n" +
      "      vue = false;\n" +
      "    }\n",
    apres: "    const vue = capacite.presente(portee) === true;\n",
    epreuves: [EPREUVE_CYCLE],
  },
  {
    nom: "un volume ABSENT n'est pas ouvert pour poser la question : cela le créerait",
    garde: "constaterLExclusivite — le constat « sans-volume » avant toute ouverture",
    fichier: EXCLUSIVITE,
    avant: "  if (!observe.present) return constat(VERDICTS_DEXCLUSIVITE.sansVolume);\n",
    apres: "",
    epreuves: [EPREUVE_APPLICATION],
  },
  {
    nom: "le handle pris pour constater l'exclusivité est RELÂCHÉ",
    garde: "constaterLExclusivite — la fermeture du handle",
    fichier: EXCLUSIVITE,
    avant: "    handle.close();",
    apres: "    void handle;",
    epreuves: [EPREUVE_APPLICATION],
  },
  {
    nom: "un moteur sans OPFS synchrone ne dérange pas le support pour le savoir",
    garde: "constaterLExclusivite — le court-circuit sur `peutOuvrir`",
    fichier: EXCLUSIVITE,
    avant: "  if (!peutOuvrir) return constat(VERDICTS_DEXCLUSIVITE.indisponible);\n",
    apres: "",
    epreuves: [EPREUVE_APPLICATION],
  },
  {
    nom: "un descripteur d'une AUTRE version est refusé, jamais deviné",
    garde: "lireLeDescripteur — le contrôle de version",
    fichier: APPLICATION,
    avant:
      "  if (descripteur?.descripteurVersion !== DESCRIPTEUR_VERSION_ATTENDUE) {\n" +
      "    return {\n" +
      "      present: false,\n" +
      "      motif: `version de descripteur inconnue : ${String(descripteur?.descripteurVersion)}`,\n" +
      "    };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_APPLICATION],
  },
  {
    nom: "une origine sans application rend son motif, et non un descripteur vide",
    garde: "lireLeDescripteur — le contrôle du statut HTTP",
    fichier: APPLICATION,
    avant:
      "  if (!reponse.ok) {\n" +
      "    return { present: false, motif: `aucun descripteur servi (${reponse.status})` };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_APPLICATION],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "cycle-de-vie" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
