// L'ÉTAT DE RÉVOCATION MONOTONE, partagé par toute la page (#299, ADR 0048 § 7, constat de la revue de #312).
//
// La fraîcheur tourne en parallèle des autres vérifications ; un portail qui en prend une décision puis
// attend peut laisser passer une révocation connue ENTRE la décision et la création du Worker. La règle :
//
//  - UN SEUL état par page, partagé par l'observateur (§ 8) et par TOUS les portails (premier démarrage,
//    réouverture après verrouillage, tout autre point de création d'un Worker de confiance) ;
//  - il est MONOTONE : il passe de « inconnue » à « connue » (avec sa cause, `plancher` ou `retrait`) et ne
//    revient JAMAIS en arrière — ni par un recalcul de fraîcheur, ni par un nouveau portail, ni par la
//    disparition du Worker en attente. Il n'existe donc AUCUNE fonction qui l'efface ;
//  - le dernier portail le relit dans le même tour que `new Worker`, sans `await` entre les deux.
//
// Même nature, même règle pour le changement de contrôleur : une ANOMALIE qui ne se défait pas.

const CAUSES = Object.freeze(["plancher", "retrait"]);

export function creerEtatPartage() {
  let cause = null;
  let controleurChange = false;
  return {
    /** Une révocation est-elle connue ? */
    connue: () => cause !== null,
    /** La première cause connue (`plancher` ou `retrait`), ou `null`. */
    cause: () => cause,
    /** Écrit une révocation connue. Toute autre valeur, ou une seconde cause, est sans effet. */
    noter(nouvelle) {
      if (cause === null && CAUSES.includes(nouvelle)) cause = nouvelle;
    },
    /** Un `controllerchange` a eu lieu pendant la vie de la page. */
    controleurChange: () => controleurChange,
    noterLeChangementDeControleur() {
      controleurChange = true;
    },
  };
}
