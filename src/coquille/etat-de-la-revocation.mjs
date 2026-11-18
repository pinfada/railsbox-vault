// L'ÉTAT UNIQUE de la révocation d'urgence, pour tout le document (#265, relecture de #308).
//
// Un seul drapeau, trois phases : `repos`, `en-vol` (la demande part ou attend sa réponse),
// `incertaine` (un échec est survenu APRÈS l'envoi : la révocation a peut-être eu lieu). Il est posé
// de façon SYNCHRONE, dans le tour de boucle de la décision « Oui », AVANT le `postMessage`, et lu
// de façon synchrone par chaque gestionnaire de sortie de l'étape 9. Il ne dépend d'AUCUN rendu :
// `disabled` s'y ajoute pour la personne, mais la garde est dans le gestionnaire. Un rendu différé
// pendant un appui (`pression-du-bouton.mjs`) ou un `dispatchEvent()` synthétique n'y changent rien.
//
// Levée : une révocation qui aboutit (`aboutir`), ou la réouverture du coffre — qui recharge le
// document, donc ce module.

export const PHASES_DE_LA_REVOCATION = Object.freeze({
  repos: "repos",
  enVol: "en-vol",
  incertaine: "incertaine",
});

/** Le seul geste qui dirait « rien n'a été révoqué » : il reste fermé tant que le doute demeure. */
export const GESTE_QUI_DIT_RIEN = "parcours-sans-revoquer";

export function creerEtatDeRevocation() {
  let phase = PHASES_DE_LA_REVOCATION.repos;
  return Object.freeze({
    /** La demande part : à poser AVANT l'envoi. */
    commencer() {
      phase = PHASES_DE_LA_REVOCATION.enVol;
    },
    /** La réponse est un succès : le doute est levé. */
    aboutir() {
      phase = PHASES_DE_LA_REVOCATION.repos;
    },
    /** Un échec reçu après l'envoi : la révocation a peut-être eu lieu. */
    douter() {
      phase = PHASES_DE_LA_REVOCATION.incertaine;
    },
    phase: () => phase,
    enVol: () => phase === PHASES_DE_LA_REVOCATION.enVol,
    incertaine: () => phase === PHASES_DE_LA_REVOCATION.incertaine,
    /**
     * Le geste `id` du parcours est-il fermé ? En vol : TOUS (aucun ne quitte l'étape ni ne dit quoi
     * que ce soit d'une demande qui peut aboutir). Incertaine : celui qui dirait « rien n'a été
     * révoqué ».
     */
    sortieFermee(id) {
      return (
        phase === PHASES_DE_LA_REVOCATION.enVol ||
        (phase === PHASES_DE_LA_REVOCATION.incertaine && id === GESTE_QUI_DIT_RIEN)
      );
    },
  });
}

/** L'état du document : la page et les gestes de portabilité partagent CETTE instance. */
export const REVOCATION = creerEtatDeRevocation();
