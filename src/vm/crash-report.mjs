// Compte rendu d'une matrice de coupures (#15).
//
// Il agrège ce que les points ont laissé sur le support et publie la MESURE que #16 devra porter à
// 100 % : la part des points de coupure qui laissent le volume dans l'ancien état ou dans le
// nouveau. `docs/quality-attributes.md` demande que « 100 % des points de coupure donnent ancien
// état, nouvel état ou erreur explicite » ; #15 ne le garantit pas, il le mesure et publie le
// chiffre tel qu'il est.
//
// Le compte rendu n'est PAS un format persistant : il n'est écrit sur aucun volume, il ne survit
// pas à l'exécution qui le produit, et rien ne le relit. Il porte tout de même un numéro de
// version, pour qu'un relevé collé dans une PR dise de quelle forme il vient. Aucun ADR n'est
// requis pour cela — la compatibilité persistante du dépôt n'est pas engagée.

import { estVerdictConnu } from "./crash-oracle.mjs";
import {
  BARRIERES,
  BARRIERE_TOUS_LES,
  BLOCS_SUIVIS,
  BLOC_OCTETS,
  ECRITURES,
  PASSES,
} from "./crash-scenario.mjs";

/**
 * Profil du scénario mesuré. Un taux sans lui n'est comparable à rien : 0,25 sur douze points de
 * vingt-quatre écritures et 0,125 sur huit points du même scénario ne disent pas la même chose, et
 * #16 aura besoin de savoir sur quoi la comparaison porte.
 */
const PROFIL_MESURE = Object.freeze({
  blocsSuivis: BLOCS_SUIVIS,
  tailleBloc: BLOC_OCTETS,
  // `ecritures` est publié à part du nombre de blocs suivis : un scénario à plusieurs passes les
  // dissocierait, et un taux comparé sans ce chiffre ne dirait plus sur quel travail il porte.
  ecritures: ECRITURES,
  passes: PASSES,
  barrieres: BARRIERES,
  barriereTousLes: BARRIERE_TOUS_LES,
});

/** Version de la forme du compte rendu. Un relevé publié dit toujours de quelle forme il vient. */
export const RESILIENCE_REPORT_VERSION = 1;

/** Quatre décimales : au-delà, le chiffre affiché serait plus précis que la mesure. */
function taux(part, total) {
  return total === 0 ? 0 : Number((part / total).toFixed(4));
}

/**
 * Résume une matrice rejouée.
 *
 * @param {{ graine: number, resultats: readonly object[], support?: string | null }} entree
 *   `resultats` est la sortie de `rejouerCoupure`, un élément par point.
 *   `support` nomme le support éprouvé — « double calibré » ou « OPFS Chromium » — parce qu'un taux
 *   ne veut rien dire sans lui.
 */
export function resumerMatrice({ graine, resultats, support = null }) {
  if (!Array.isArray(resultats) || resultats.length === 0) {
    throw new RangeError("Aucun point rejoué : un taux sur zéro point ne mesurerait rien.");
  }

  // Les verdicts INTERMÉDIAIRES sont nommés par génération (`generation-1`, `generation-2`…) : le
  // compte les accueille au fur et à mesure plutôt que sur une liste figée, sans quoi un scénario à
  // quatre générations publierait un total qui ne retomberait pas sur ses pieds.
  const verdicts = { ancien: 0, nouveau: 0, melange: 0, corrompu: 0 };
  const classes = { ancien: 0, nouveau: 0, dechire: 0, corrompu: 0 };
  let atomiques = 0;
  let entreesJournal = 0;
  let pointsSansJournal = 0;

  for (const resultat of resultats) {
    if (!estVerdictConnu(resultat.verdict)) {
      throw new Error(`Verdict inconnu dans la matrice : ${resultat.verdict}`);
    }
    verdicts[resultat.verdict] = (verdicts[resultat.verdict] ?? 0) + 1;
    for (const [classe, compte] of Object.entries(resultat.classes)) classes[classe] += compte;
    if (resultat.atomique) atomiques += 1;
    entreesJournal += resultat.entreesJournal ?? 0;
    if (resultat.journalConsulte !== true) pointsSansJournal += 1;
  }

  return Object.freeze({
    version: RESILIENCE_REPORT_VERSION,
    graine,
    support,
    profil: PROFIL_MESURE,
    pointsRejoues: resultats.length,
    verdicts: Object.freeze(verdicts),
    classes: Object.freeze(classes),
    /**
     * Ce que l'oracle a eu SOUS LES YEUX. Un point classé sans journal n'a pas pu déclencher la
     * règle `SEC-DURABLE-001` : le taux atomique en sortirait plus élevé, et il faut donc que le
     * compte rendu le dise plutôt que de le laisser deviner.
     */
    entreesJournal,
    pointsSansJournal,
    /** Part des points qui laissent « ancien ou nouveau ». C'est la mesure de #16. */
    tauxAtomique: taux(atomiques, resultats.length),
    /**
     * Nombre d'états que l'oracle savait NOMMER. Deux ne veut pas dire la même chose que quatre :
     * un oracle à deux états ne distingue pas un mécanisme correct d'un mécanisme qui acquitte une
     * génération puis la perd, et un taux publié sans ce chiffre ne dit pas ce qu'il a jugé.
     */
    generationsAttendues: resultats[0].generationsAttendues ?? null,
    /** De quoi rejouer chaque point SEUL : sa graine et sa description complète. */
    rejeu: Object.freeze(
      resultats.map((resultat) =>
        Object.freeze({
          graine,
          point: resultat.point,
          verdict: resultat.verdict,
          raison: resultat.raison,
          arret: resultat.arret,
        }),
      ),
    ),
  });
}
