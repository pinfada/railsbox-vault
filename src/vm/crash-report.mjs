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

import { VERDICTS } from "./crash-oracle.mjs";
import { BARRIERE_TOUS_LES, BLOC_OCTETS, BLOCS_SUIVIS } from "./crash-scenario.mjs";

/**
 * Profil du scénario mesuré. Un taux sans lui n'est comparable à rien : 0,25 sur douze points de
 * vingt-quatre écritures et 0,125 sur huit points du même scénario ne disent pas la même chose, et
 * #16 aura besoin de savoir sur quoi la comparaison porte.
 */
const PROFIL_MESURE = Object.freeze({
  blocsSuivis: BLOCS_SUIVIS,
  tailleBloc: BLOC_OCTETS,
  ecritures: BLOCS_SUIVIS,
  barrieres: Math.ceil(BLOCS_SUIVIS / BARRIERE_TOUS_LES),
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

  const verdicts = { ancien: 0, nouveau: 0, melange: 0, corrompu: 0 };
  const classes = { ancien: 0, nouveau: 0, dechire: 0, corrompu: 0 };
  let atomiques = 0;
  let entreesJournal = 0;
  let pointsSansJournal = 0;

  for (const resultat of resultats) {
    if (!Object.values(VERDICTS).includes(resultat.verdict)) {
      throw new Error(`Verdict inconnu dans la matrice : ${resultat.verdict}`);
    }
    verdicts[resultat.verdict] += 1;
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
