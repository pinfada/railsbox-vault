#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes des FINS D'ONGLET (#170, tranche 2 de #25, ADR 0032).
//
//     node tools/muter-gardes-fins-d-onglet.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les six campagnes précédentes :
// recopie du dépôt dans un atelier temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, épreuve jouée
// SANS mutation d'abord, `node --check` sur le fichier muté, arrêt sans verdict compté NON
// CONCLUANT. Ce fichier ne tient que sa TABLE.
//
// ## Pourquoi cette campagne compte DOUBLE pour cette tranche
//
// La sonde de `tests/fins-d-onglet/` a MESURÉ, sur les trois moteurs, que sous Playwright **aucun
// document n'est jamais restauré depuis le bfcache** — témoin positif compris — et qu'**aucun onglet
// ne devient jamais caché**. Quatre des cinq chemins de `fins-d-onglet.mjs` — `pageshow` restauré,
// `freeze`, `resume`, le retour à la visibilité — ne sont donc atteignables par AUCUNE épreuve de
// navigateur de ce dépôt.
//
// Ce que cette campagne dit est par conséquent tout ce qui est dit d'eux : que la décision sait
// rougir. C'est pour cela que le module reçoit son document, sa fenêtre, sa surveillance, l'état du
// coffre, la terminaison et le rechargement en PARAMÈTRES — sans cette injection, ces quatre
// décisions seraient des lignes qu'on croit sur parole.
//
// ## Ce que la campagne ne peut PAS mesurer, et il faut le dire
//
// Elle ne mesure pas ce que le NAVIGATEUR livre : qu'un `pagehide` arrive à la fermeture d'un
// onglet, qu'un `freeze` existe, qu'un document soit restauré. Cela relève de
// `tests/fins-d-onglet/fins-d-onglet.spec.mjs`, dont la matrice est publiée dans
// `docs/compatibility.md` — et dont plusieurs lignes disent « non simulable », avec leur motif.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const FINS = "src/coquille/fins-d-onglet.mjs";
const VERROUILLAGE = "src/coquille/verrouillage.mjs";

const EPREUVE = "tests/unit/coquille-fins-d-onglet.test.mjs";

/**
 * Les gardes de #170, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "`pagehide` TUE le Worker de confiance",
    garde:
      "gesteDeFin — la terminaison, seule chose que le moteur garantisse encore dans cette tâche",
    fichier: FINS,
    avant: "    tuerLeWorker();\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "`pagehide` tue quel que soit `persisted` — un seul chemin, pas deux",
    garde: "gesteDeFin — l'absence de condition sur `persisted`",
    fichier: FINS,
    avant: "    tuerLeWorker();",
    apres: "    if (evenement?.persisted !== true) tuerLeWorker();",
    epreuves: [EPREUVE],
  },
  {
    nom: "`pagehide` ne tue QUE sur un coffre ouvert",
    garde: "gesteDeFin — la condition d'ÉTAT",
    fichier: FINS,
    avant:
      "    if (!coffreOuvert()) {\n" +
      '      journal("pagehide", "coffre-non-ouvert");\n' +
      "      return;\n" +
      "    }\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "`pagehide` DÉSARME le délai : aucune minuterie ne survit au départ du document",
    garde: "gesteDeFin — le désarmement de la surveillance",
    fichier: FINS,
    avant: "    surveillance.desarmer();\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "`pageshow` RESTAURÉ recharge la coquille",
    garde: "gesteDeRetour — le rechargement",
    fichier: FINS,
    avant: "    recharger();\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "`pageshow` ne recharge QUE s'il est restauré — sinon, boucle infinie",
    garde: "gesteDeRetour — la condition sur `persisted`",
    fichier: FINS,
    avant: "    if (evenement?.persisted !== true) return;\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "le GEL ne tue RIEN",
    garde: "gesteDeGel — l'inaction, qui est la décision",
    fichier: FINS,
    avant: 'function gesteDeGel({ journal }) {\n  return () => journal("freeze", "sans-effet");\n}',
    apres:
      "function gesteDeGel({ journal, tuerLeWorker }) {\n" +
      "  return () => {\n" +
      "    tuerLeWorker();\n" +
      '    journal("freeze", "tue");\n' +
      "  };\n}",
    epreuves: [EPREUVE],
  },
  {
    nom: "le RETOUR vérifie l'échéance",
    garde: "gesteDeVerification — l'appel à `verifierLEcheance`",
    fichier: FINS,
    avant: '    if (surveillance.verifierLEcheance()) journal(nom, "echeance-depassee");\n',
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "un onglet qui PART en arrière-plan ne vérifie rien",
    garde: "gesteDeVerification — la condition de VISIBILITÉ",
    fichier: FINS,
    avant: '    if (nom === "visibilitychange" && racine.visibilityState !== "visible") return;\n',
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "chaque événement est écouté sur SA cible — la fenêtre ou le document",
    garde: "brancherLesFinsDOnglet — la table des cibles",
    fichier: FINS,
    avant: "    cibles[cible].addEventListener(evenement, gestes[evenement], { passive: true });",
    apres: "    racine.addEventListener(evenement, gestes[evenement], { passive: true });",
    epreuves: [EPREUVE],
  },
  {
    nom: "`beforeunload` n'est branché NULLE PART",
    garde: "brancherLesFinsDOnglet — l'absence d'écouteur, surveillée par le cliquet",
    fichier: FINS,
    avant: "  for (const [evenement, { cible }] of Object.entries(EVENEMENTS_DE_FIN)) {",
    apres:
      '  fenetre.addEventListener("beforeunload", () => {});\n' +
      "  for (const [evenement, { cible }] of Object.entries(EVENEMENTS_DE_FIN)) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "la vérification ne fait rien sur une surveillance DÉSARMÉE",
    garde: "surveillanceDInactivite.verifierLEcheance — la condition d'ARMEMENT",
    fichier: VERROUILLAGE,
    avant: "    verifierLEcheance() {\n      if (minuterie === null) return false;\n",
    apres: "    verifierLEcheance() {\n",
    epreuves: [EPREUVE],
  },
  {
    nom: "la vérification ne verrouille PAS avant l'échéance",
    garde: "surveillanceDInactivite.verifierLEcheance — la comparaison à l'HORLOGE",
    fichier: VERROUILLAGE,
    avant: "      if (maintenant() - dernierSigneMs < delai) return false;\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "la vérification ne REMET RIEN à zéro : l'échéance ne bouge pas",
    garde: "surveillanceDInactivite.verifierLEcheance — l'absence de remise à zéro",
    fichier: VERROUILLAGE,
    avant: "      if (maintenant() - dernierSigneMs < delai) return false;",
    apres:
      "      if (maintenant() - dernierSigneMs < delai) {\n" +
      "        dernierSigneMs = maintenant();\n" +
      "        return false;\n" +
      "      }",
    epreuves: [EPREUVE],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "fins-d-onglet" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
