// La MORT du Worker de confiance : ce qu'on en constate, et la conduite qui en découle
// (#163, ADR 0030, décision 3).
//
// ## La frontière avec #25, écrite pour qu'aucune ne préempte l'autre
//
// **#163 possède la DÉTECTION et la CONDUITE** : constater qu'un Worker ne répond plus, poser la
// coquille dans l'état que #25 définit, et le dire au cadre. **#25 possède l'ÉTAT et la RÈGLE** :
// ce que « verrouillé » veut dire, les déclencheurs, le délai. Ce module CITE `verrouille` — le nom
// que `etat-de-la-coquille.mjs` porte depuis #161 et dont #25 fixera le sens — et ne choisit ni
// quand ni pourquoi on y arrive autrement que par la mort constatée ici.
//
// La position tombe d'elle-même une fois cette frontière posée : **verrouiller, c'est atteindre
// volontairement l'état que la mort du Worker atteint par accident.** Un seul état, deux chemins.
//
// ## Refuser tout service jusqu'à un geste explicite
//
// Des deux options ouvertes par la Definition of Ready de #24 — redemander le geste, ou refuser
// jusqu'à un geste —, c'est la seconde. Elles ne diffèrent que par un point, et il faut le nommer :
// **remonter l'interface de déverrouillage n'est pas « redemander automatiquement »**. La coquille
// l'affiche, et ne dérive RIEN tant que personne n'a agi. Les deux secondes d'Argon2id se paient
// dans les deux cas ; la seule question est qui décide de les payer, et ce n'est pas la coquille.
//
// Aucune KEK n'est gardée « pour plus tard » : elle vivait dans le tas du Worker, et ce tas est
// parti avec lui. Ce que ce module peut affirmer est exactement cela — pas que des octets ont été
// effacés (ADR 0021, décision 7 : c'est IMPOSSIBLE à garantir pour une `string`, et seulement FAIT
// mais non garanti pour un tampon).

import { ETATS_DU_VOLUME } from "./etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";

/**
 * Les TROIS façons dont la coquille constate qu'un Worker ne la sert plus. Il n'y en a pas de
 * quatrième, et une cause hors table est refusée plutôt que rangée dans la plus proche : constater
 * une mort par défaut ferait verrouiller un coffre vivant.
 */
export const CAUSES_DE_MORT = Object.freeze({
  /** `error` ou `messageerror` sur le Worker : il a jeté, ou il n'a pas su décoder un message. */
  erreur: "erreur",
  /** Aucune réponse sous `DELAI_WORKER_MORT_MS` : il est bloqué, ou il est mort. */
  silence: "silence",
  /** `terminate()` appelé par la coquille elle-même — c'est le chemin de la fermeture propre. */
  terminaison: "terminaison",
});

const CAUSES_CONNUES = new Set(Object.values(CAUSES_DE_MORT));

/**
 * La CONDUITE à tenir, une fois la mort constatée.
 *
 * Elle ne dépend PAS de la cause : un Worker terminé par la coquille et un Worker qui a jeté
 * laissent la même coquille — sans clé, sans handle, sans volume. Distinguer les deux dans la
 * conduite ferait croire qu'un des deux chemins garde quelque chose.
 *
 * `etatConnu` est le dernier état publié. Il ne sert qu'à UNE chose : ne pas inventer un verrou sur
 * un moteur `indisponible`, où rien n'a jamais pu s'ouvrir. Confondre les deux dirait à
 * l'utilisateur d'un moteur sans OPFS synchrone qu'un geste rouvrirait son coffre.
 *
 * @param {{ cause: string, etatConnu?: string, barrieres?: number }} constat
 */
export function conduiteApresLaMort({
  cause,
  etatConnu = ETATS_DU_VOLUME.verrouille,
  barrieres = 0,
}) {
  if (!CAUSES_CONNUES.has(cause)) {
    throw new Error(
      `Cause de mort inconnue : ${String(cause)}. La coquille ne constate pas une mort par défaut.`,
    );
  }
  const etat =
    etatConnu === ETATS_DU_VOLUME.indisponible
      ? ETATS_DU_VOLUME.indisponible
      : ETATS_DU_VOLUME.verrouille;
  return Object.freeze({
    cause,
    /** L'état que #25 nomme. #163 y arrive, #25 dit ce qu'il veut dire. */
    etat,
    /** Le compte de barrières ne recule pas : il est monotone, et la mort n'est pas un recommencement. */
    barrieres,
    /** Le refus que TOUT geste en vol reçoit désormais, avec son code propre. */
    code: CODES_REFUS_COQUILLE.workerMort,
    /** L'interface de déverrouillage est REMONTÉE — montrée, pas actionnée. */
    interfaceRemontee: true,
    /** Rien n'est dérivé tant que personne n'a agi. C'est toute la différence avec l'autre option. */
    derivationPermise: false,
    /** La poussée de barrière cesse : il n'y a plus personne pour en acquitter une. */
    pousseeDeBarriere: false,
    /** Aucune KEK gardée : elle vivait dans le tas du Worker, et il est parti. */
    kekRetenue: false,
  });
}

/**
 * Ce refus vient-il de la mort du Worker ? La question se pose du côté des appelants, qui doivent
 * distinguer « le geste a été refusé » de « il n'y a plus personne pour le servir ».
 *
 * @param {{ code?: unknown } | null | undefined} erreur
 */
export function estUneMortDuWorker(erreur) {
  return erreur?.code === CODES_REFUS_COQUILLE.workerMort;
}
