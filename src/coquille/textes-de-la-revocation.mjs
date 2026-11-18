// Ce que la page dit de la RÉVOCATION D'URGENCE : l'avertissement écrit au-dessus du bouton, la
// confirmation, l'annulation et les issues d'une révocation en vol (#265, relecture de #308).
// Extraits de `textes-du-parcours.mjs` (qui les réunit dans `MESSAGES`) : ce fichier approchait du
// plafond, et ces textes ne dépendent que des noms de moyens.

import { MOYEN_NOMME, lesAutresRetires } from "./moyens-nommes.mjs";

export const TEXTES_DE_LA_REVOCATION = Object.freeze({
  // La CONFIRMATION de la révocation (#265) : l'irréversible, ce qui part, ce qui reste, la sortie.
  titreDeLaConfirmationDeRevocation: "Confirmer la révocation",
  confirmationDeRevocation: (moyen, moyens = null, options = {}) =>
    "Révoquer est irréversible : ce qui est retiré ne pourra pas être rendu. " +
    `${TEXTES_DE_LA_REVOCATION.avertissementDeRevocation(moyen, moyens, options)} Vos sauvegardes déjà faites ne changent ` +
    "pas : elles restent ouvrables par les anciens moyens. Rien n'est retiré tant que vous n'avez " +
    "pas cliqué sur « Oui, révoquer les autres moyens » ; « Annuler » ne change rien.",
  revocationAnnulee: "Rien n'a été révoqué : tout ce qui ouvrait ce coffre l'ouvre toujours.",
  // La révocation EN VOL : elle est partie, elle ne s'annule plus (relecture de #308). Tout échec reçu
  // ensuite — refus typé, Worker mort, Worker rompu, erreur sans code — se dit de la MÊME façon : « a
  // peut-être eu lieu ». Une erreur peut survenir après la publication de la page neuve (ADR 0026) et
  // le Worker n'atteste pas la phase : « refusée » ou « rien n'a changé » seraient des affirmations
  // que la page ne peut pas tenir.
  revocationEnCours:
    "Révocation en cours : la demande est partie et ne peut plus être annulée. Attendez la réponse " +
    "du coffre.",
  revocationIncertaine:
    "La révocation est partie, mais le coffre ne l'a pas confirmée (la raison, s'il en a donné une, " +
    "est écrite plus haut) : elle a peut-être eu lieu. " +
    "Rouvrez votre coffre : si l'un des moyens que vous vouliez retirer l'ouvre encore, refaites " +
    "la révocation.",
  avertissementDeRevocation: (moyen, moyens = null, options = {}) =>
    MOYEN_NOMME[moyen] === undefined
      ? "Seul le moyen avec lequel vous avez ouvert ce coffre continuera de l'ouvrir ; tous les " +
        "autres ne fonctionneront plus."
      : `Seul le moyen avec lequel vous venez d'ouvrir ce coffre — ${MOYEN_NOMME[moyen]} — ` +
        `continuera de l'ouvrir. ${lesAutresRetires(moyen, moyens, options)}`,
});
