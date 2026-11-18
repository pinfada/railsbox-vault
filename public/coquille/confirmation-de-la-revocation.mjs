// La CONFIRMATION de la révocation d'urgence, côté page du parcours (#265).
//
// Le geste lui-même — ouvrir, annuler, confirmer — est branché par `gestes-de-portabilite.mjs`
// (`src/coquille/confirmation-en-deux-temps.mjs`). Ce module écrit ce que la confirmation DIT, avec
// ce que la page sait du coffre, et ferme une demande dont le geste a disparu de l'écran.

import { oublierLaConfirmation } from "/src/coquille/confirmation-en-deux-temps.mjs";
import { MESSAGES } from "/src/coquille/textes-du-parcours.mjs";

/**
 * Appelé à chaque rendu, APRÈS que les blocs ont été montrés ou cachés. La confirmation redit ce que
 * « Révoquer… » retire et garde, au moment où la personne va agir ; si le bloc de la révocation est
 * caché (un changement d'étape), la demande est oubliée : une demande périmée ne survit pas.
 *
 * @param {{ noeud: (id: string) => any, dire: (id: string, texte: string) => void,
 *           releve: { moyenDOuverture?: string, moyensProposes?: string[] } }} page
 */
export function suivreLaConfirmationDeRevocation({ noeud, dire, releve }) {
  dire("revocation-confirmation-titre", MESSAGES.titreDeLaConfirmationDeRevocation);
  dire(
    "revocation-confirmation-texte",
    MESSAGES.confirmationDeRevocation(releve.moyenDOuverture, releve.moyensProposes ?? null),
  );
  if (noeud("revocation-confirmation")?.closest("[data-bloc]")?.hidden !== true) return;
  oublierLaConfirmation({
    noeud,
    declencheur: "revoquer-en-urgence",
    panneau: "revocation-confirmation",
  });
}
