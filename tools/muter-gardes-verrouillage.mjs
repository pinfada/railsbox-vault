#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du VERROUILLAGE (#169, tranche 1 de #25, ADR 0031).
//
//     node tools/muter-gardes-verrouillage.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les cinq campagnes
// précédentes : recopie du dépôt dans un atelier temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant,
// épreuve jouée SANS mutation d'abord, `node --check` sur le fichier muté, arrêt sans verdict compté
// NON CONCLUANT. Ce fichier ne tient que sa TABLE.
//
// ## Pourquoi ces gardes-là, et pas celles de la page
//
// Le même partage que pour #161 et #163 : ce que cette tranche décide vit dans `src/coquille/`, et
// `public/main.mjs` ne fait que l'appeler. Une garde écrite dans la page ne serait éprouvable que par
// un navigateur, donc jamais par un enfant borné — et une garde qu'aucune mutation ne peut atteindre
// est une garde qu'on croit sur parole.
//
// C'est pour cela que la surveillance d'inactivité reçoit son HORLOGE et son ORDONNANCEUR en
// paramètres. Sans cette injection, la décision la plus importante de la tranche — quand un coffre
// laissé se verrouille — serait hors de portée de toute campagne, et une épreuve qui la mesurerait
// coûterait dix minutes.
//
// ## Ce que la campagne ne peut PAS mesurer, et il faut le dire
//
// Elle ne mesure pas ce que le NAVIGATEUR fait de ces décisions : qu'un `pointerdown` soit livré au
// document de la coquille, qu'une minuterie d'un onglet en arrière-plan atteigne son échéance, qu'un
// `location.reload()` rejoue le cycle, que `close()` libère réellement un handle exclusif. Cela
// relève de `tests/browser/coquille-cycle-de-vie.spec.mjs` sur les trois moteurs — dont deux
// épreuves paient une minute réelle d'inactivité — et de
// `tests/e2e/reprise-coquille-boot-froid.spec.mjs` en intégration continue. Les deux se complètent :
// la campagne dit que la décision sait rougir, le navigateur dit qu'elle porte sur quelque chose.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const VERROUILLAGE = "src/coquille/verrouillage.mjs";
const GESTES = "src/coquille/gestes-du-cycle.mjs";

const EPREUVE = "tests/unit/coquille-verrouillage.test.mjs";

/**
 * Les gardes de #169, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "le délai n'est armé QUE sur un coffre ouvert",
    garde: "surveillanceDInactivite.armer — la condition d'ÉTAT",
    fichier: VERROUILLAGE,
    avant:
      "      if (etat !== ETATS_DU_VOLUME.ouvert) {\n" +
      "        desarmer();\n" +
      "        verrouillageDu = false;\n" +
      "        return false;\n" +
      "      }\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "ré-armer un coffre DÉJÀ armé ne repousse pas l'échéance",
    garde:
      "surveillanceDInactivite.armer — l'IDEMPOTENCE, sur laquelle repose « aucun message du cadre ne compte »",
    fichier: VERROUILLAGE,
    avant: "      if (minuterie !== null) return false;\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "les BARRIÈRES ne comptent pas comme activité",
    garde: "SIGNAUX_DACTIVITE — la liste FERMÉE de ce qui remet le délai à zéro",
    fichier: VERROUILLAGE,
    avant: 'export const SIGNAUX_DACTIVITE = Object.freeze(["clavier", "focus", "pointeur"]);',
    apres:
      'export const SIGNAUX_DACTIVITE = Object.freeze(["clavier", "focus", "pointeur", "barriere"]);',
    epreuves: [EPREUVE],
  },
  {
    nom: "aucun message du CADRE ne compte comme activité",
    garde: "SIGNAUX_DACTIVITE — le contrat n'admet aucun « je suis là »",
    fichier: VERROUILLAGE,
    avant:
      'export const SIGNAUX_SANS_EFFET = Object.freeze(["barriere", "message-du-cadre", "visibilite"]);',
    apres:
      'export const SIGNAUX_SANS_EFFET = Object.freeze(["barriere", "visibilite"]);\n' +
      'export const SIGNAUX_DACTIVITE_BIS = Object.freeze(["message-du-cadre"]);',
    epreuves: [EPREUVE],
  },
  {
    nom: "un document CACHÉ ne remet pas le délai à zéro",
    garde: "estUnSignalDActivite — la visibilité n'est pas de l'activité",
    fichier: VERROUILLAGE,
    avant: "  return SIGNAUX_DACTIVITE.includes(nom);\n",
    apres: '  return SIGNAUX_DACTIVITE.includes(nom) || nom === "visibilite";\n',
    epreuves: [EPREUVE],
  },
  {
    nom: "la borne BASSE du délai est tenue",
    garde: "delaiDInactivite — un délai sous la minute est refusé",
    fichier: VERROUILLAGE,
    avant:
      "  if (valeur < DELAI_INACTIVITE_MINIMUM_MS) {\n" +
      "    throw new Error(\n" +
      "      `Délai d'inactivité refusé : ${valeur} ms est sous la borne de ${DELAI_INACTIVITE_MINIMUM_MS} ms.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "la borne HAUTE du délai est tenue",
    garde: "delaiDInactivite — au-delà d'une heure, le délai ne borne plus rien",
    fichier: VERROUILLAGE,
    avant:
      "  if (valeur > DELAI_INACTIVITE_MAXIMUM_MS) {\n" +
      "    throw new Error(\n" +
      "      `Délai d'inactivité refusé : ${valeur} ms dépasse la borne de ${DELAI_INACTIVITE_MAXIMUM_MS} ms.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "la borne est tenue à la CONSTRUCTION de la surveillance, pas seulement dans une fonction",
    garde: "surveillanceDInactivite — la valeur passe par `delaiDInactivite`",
    fichier: VERROUILLAGE,
    avant: "  const delai = delaiDInactivite(delaiMs);",
    apres: "  const delai = delaiMs;",
    epreuves: [EPREUVE],
  },
  {
    nom: "un réveil de minuterie ne verrouille pas : c'est l'HORLOGE qui décide",
    garde: "surveillanceDInactivite.verifier — la replanification du reste",
    fichier: VERROUILLAGE,
    avant:
      "    const reste = delai - (maintenant() - dernierSigneMs);\n" +
      "    if (reste > 0) {\n" +
      "      minuterie = planifier(verifier, reste);\n" +
      "      return;\n" +
      "    }\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "un signal reçu sur une surveillance DÉSARMÉE ne l'arme pas",
    garde: "surveillanceDInactivite.signaler — la condition d'armement",
    fichier: VERROUILLAGE,
    avant:
      "    signaler(nom) {\n" +
      "      if (minuterie === null) return false;\n" +
      "      if (!estUnSignalDActivite(nom)) return false;\n",
    apres: "    signaler(nom) {\n      if (!estUnSignalDActivite(nom)) return false;\n",
    epreuves: [EPREUVE],
  },
  {
    nom: "le verrouillage RECHARGE la coquille",
    garde: "conduiteApresLeVerrouillage — le cadre est retiré par rechargement",
    fichier: VERROUILLAGE,
    avant: "    rechargerLaCoquille: true,",
    apres: "    rechargerLaCoquille: false,",
    epreuves: [EPREUVE],
  },
  {
    nom: "le geste qui rouvre n'est PAS offert après un verrouillage — l'asymétrie avec la mort",
    garde: "conduiteApresLeVerrouillage — le bouton « Rouvrir » appartient au chemin accidentel",
    fichier: VERROUILLAGE,
    avant: "    gesteQuiRouvreOffert: false,",
    apres: "    gesteQuiRouvreOffert: true,",
    epreuves: [EPREUVE],
  },
  {
    nom: "rien ne rouvre sans un NOUVEAU geste",
    garde: "conduiteApresLeVerrouillage — jamais de réouverture automatique",
    fichier: VERROUILLAGE,
    avant: "    reouvertureAutomatique: false,",
    apres: "    reouvertureAutomatique: true,",
    epreuves: [EPREUVE],
  },
  {
    nom: "aucune dérivation n'est permise après un verrouillage",
    garde: "conduiteApresLeVerrouillage — la garde à l'entrée du CALCUL",
    fichier: VERROUILLAGE,
    avant: "    derivationPermise: false,",
    apres: "    derivationPermise: true,",
    epreuves: [EPREUVE],
  },
  {
    nom: "aucune KEK n'est gardée « pour plus tard »",
    garde: "conduiteApresLeVerrouillage — le tas du Worker est parti avec lui",
    fichier: VERROUILLAGE,
    avant: "    kekRetenue: false,",
    apres: "    kekRetenue: true,",
    epreuves: [EPREUVE],
  },
  {
    nom: "l'INSTANTANÉ n'est PAS retiré par le verrouillage",
    garde: "conduiteApresLeVerrouillage — révision datée de l'ADR 0024 décision 8",
    fichier: VERROUILLAGE,
    avant: "    instantaneRetire: false,",
    apres: "    instantaneRetire: true,",
    epreuves: [EPREUVE],
  },
  {
    nom: "un moteur INDISPONIBLE ne se voit pas inventer un verrou",
    garde: "conduiteApresLeVerrouillage — `indisponible` n'est pas `verrouille`",
    fichier: VERROUILLAGE,
    avant:
      "  const etat =\n" +
      "    etatConnu === ETATS_DU_VOLUME.indisponible\n" +
      "      ? ETATS_DU_VOLUME.indisponible\n" +
      "      : ETATS_DU_VOLUME.verrouille;",
    apres: "  const etat = ETATS_DU_VOLUME.verrouille;",
    epreuves: [EPREUVE],
  },
  {
    nom: "le Worker n'est TERMINÉ qu'APRÈS la fermeture des volumes",
    garde:
      "gestes-du-cycle.verrouiller — l'`await` qui tient l'ordre : la capture et les E/S ACCEPTÉES " +
      "d'abord, le `terminate()` ensuite",
    fichier: GESTES,
    avant: '    const rendu = await demander("fermeture", {});',
    apres:
      '    const rendu = demander("fermeture", {}).then((valeur) => valeur);\n' +
      "    apresVerrouillage(declencheur);",
    epreuves: [EPREUVE],
  },
  {
    nom: "un verrouillage REFUSÉ ne laisse pas le coffre ouvert : il RAPPELLE l'appelant",
    garde: "gestes-du-cycle.verrouiller — le rappel de la branche de refus",
    fichier: GESTES,
    avant: "    apresRefusDeVerrouillage?.(code, declencheur);\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "un verrouillage refusé TERMINE le Worker",
    garde: "conduiteApresUnRefusDeVerrouillage — le Worker ne sert plus rien, et sa KEK est partie",
    fichier: VERROUILLAGE,
    avant: "    terminerLeWorker: true,",
    apres: "    terminerLeWorker: false,",
    epreuves: [EPREUVE],
  },
  {
    nom: "un verrouillage refusé RETIRE le cadre applicatif",
    garde:
      "conduiteApresUnRefusDeVerrouillage — les pixels du cadre ne restent pas sur un coffre verrouillé",
    fichier: VERROUILLAGE,
    avant: "    retirerLeCadre: true,",
    apres: "    retirerLeCadre: false,",
    epreuves: [EPREUVE],
  },
  {
    nom: "un verrouillage refusé NE recharge PAS : le refus doit se lire",
    garde: "conduiteApresUnRefusDeVerrouillage — l'asymétrie appliquée à un accident",
    fichier: VERROUILLAGE,
    avant:
      "    rechargerLaCoquille: false,\n    /** Le bouton « Rouvrir le coffre » de #163 est offert",
    apres:
      "    rechargerLaCoquille: true,\n    /** Le bouton « Rouvrir le coffre » de #163 est offert",
    epreuves: [EPREUVE],
  },
  {
    nom: "un verrouillage demandé PENDANT un boot est refusé sous le code de l'ORDRE",
    garde: "gestes-du-cycle.refusDOrdre — la condition sur le démarrage en vol",
    fichier: GESTES,
    avant: "  if (enVol?.demarrage !== true) return null;\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "le drapeau du démarrage retombe QUOI QU'IL ARRIVE",
    garde: "gestes-du-cycle.demarrer — le `finally` qui rend le verrouillage de nouveau possible",
    fichier: GESTES,
    avant: "    enVol.demarrage = false;\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "le DÉCLENCHEUR est celui qu'on lui donne, et la table est close",
    garde: "exigerUnDeclencheur — le relevé ne publie pas un mot que personne n'a décidé",
    fichier: VERROUILLAGE,
    avant:
      "  if (!DECLENCHEURS_CONNUS.has(declencheur)) {\n" +
      "    throw new Error(\n" +
      "      `Déclencheur de verrouillage inconnu : ${String(declencheur)}. Il n'y en a que deux.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "la coquille n'écoute QUE les quatre événements de la table",
    garde: "EVENEMENTS_DACTIVITE — ce que la coquille compte comme une personne",
    fichier: VERROUILLAGE,
    avant: '  focusin: "focus",\n});',
    apres: '  focusin: "focus",\n  visibilitychange: "pointeur",\n});',
    epreuves: [EPREUVE],
  },
  {
    nom: "les écouteurs sont branchés sur le DOCUMENT, et ils sont PASSIFS",
    garde: "brancherLesSignauxDActivite — le branchement réel, et non la table qu'il lit",
    fichier: VERROUILLAGE,
    avant:
      "    racine.addEventListener(evenement, () => surveillance.signaler(signal), { passive: true });",
    apres:
      '    racine.addEventListener("focus", () => surveillance.signaler(signal), { passive: true });',
    epreuves: [EPREUVE],
  },
  {
    nom: "le bouton de la coquille est bien celui du VERROUILLAGE",
    garde: "brancherLesGestesDuCycle — un seul mot, et c'est « verrouiller »",
    fichier: GESTES,
    avant:
      '  liaison.racine.querySelector("#verrouiller-le-coffre")?.addEventListener("click", () => {',
    apres: '  liaison.racine.querySelector("#fermer-le-coffre")?.addEventListener("click", () => {',
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "verrouillage" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
