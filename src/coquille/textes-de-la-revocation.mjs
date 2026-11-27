// Les TEXTES de la révocation (#265, ADR 0049 § C2, D4) : un texte final par clé du catalogue fermé de C1,
// chacune étiquetée de ce qu'elle AFFIRME. Une phrase qui dit « révoqué », « la révocation a été faite »,
// « tous vos moyens ouvrent toujours » ou « rien n'a été révoqué » n'existe QUE dans une clé étiquetée
// `revoque` (balayage dans `tests/unit/coquille-textes-de-la-revocation.test.mjs`) : c'est ce qui rend
// un « révoqué » impossible dans un état où la page ne peut pas le savoir.

import { CLES_DE_TEXTE, ETIQUETTES } from "./cles-de-la-revocation.mjs";
import { MOYEN_NOMME, lesAutresRetires } from "./moyens-nommes.mjs";

const ROUVRIR_LE_COFFRE =
  "Rouvrez votre coffre : rechargez la page, puis ouvrez-le avec le moyen que vous avez utilisé.";

/** Ce que la révocation retire et garde, au compte exact des feuilles que la page connaît. */
export function avertissementDeRevocation(moyen, moyens = null, options = {}) {
  return MOYEN_NOMME[moyen] === undefined
    ? "Seul le moyen avec lequel vous avez ouvert ce coffre continuera de l'ouvrir ; tous les " +
        "autres ne fonctionneront plus."
    : `Seul le moyen avec lequel vous venez d'ouvrir ce coffre — ${MOYEN_NOMME[moyen]} — ` +
        `continuera de l'ouvrir. ${lesAutresRetires(moyen, moyens, options)}`;
}

/** La confirmation : l'irréversible, ce qui part, ce qui reste, la sortie. */
export function confirmationDeRevocation(moyen, moyens = null, options = {}) {
  return (
    "Révoquer est irréversible : ce qui est retiré ne pourra pas être rendu. " +
    `${avertissementDeRevocation(moyen, moyens, options)} Vos sauvegardes déjà faites ne changent ` +
    "pas : elles restent ouvrables par les anciens moyens. Rien n'est retiré tant que vous n'avez " +
    "pas cliqué sur « Oui, révoquer les autres moyens » ; « Annuler » ne change rien."
  );
}

const SEANCE = "Aucun geste de révocation n'a été fait dans cette séance.";

/**
 * Un texte par clé. Une chaîne, ou une fonction de ce que la VUE sait. Les clés sont exactement celles
 * de `CLES_DE_TEXTE` : l'épreuve de complétude rougit si l'une manque ou si une clé inconnue s'y glisse.
 */
export const TEXTES_PAR_CLE = Object.freeze({
  chargement: Object.freeze({
    titre: "Lecture de votre coffre",
    corps: "RailsBox Vault lit ce que votre coffre contient : patientez quelques secondes.",
  }),
  "chargement-apres-revocation": Object.freeze({
    titre: "Révocation faite : lecture de votre coffre",
    corps:
      "La révocation a été faite. RailsBox Vault relit ce que votre coffre contient : patientez " +
      "quelques secondes.",
  }),
  "modification-en-cours": Object.freeze({
    titre: "Modification de votre coffre en cours",
    corps: "Votre coffre est en train d'être modifié : ne fermez pas cet onglet.",
  }),
  "modification-en-cours-apres-revocation": Object.freeze({
    titre: "Modification de votre coffre en cours",
    corps:
      "La révocation a été faite. Votre coffre est en train d'être modifié : ne fermez pas cet " +
      "onglet.",
  }),
  relire: Object.freeze({
    titre: "Votre coffre doit être relu",
    corps:
      "Votre coffre n'a pas pu relire ce qu'il contient : cet écran ne peut plus dire quels moyens " +
      `l'ouvrent, ni si votre feuille est toujours juste. ${ROUVRIR_LE_COFFRE}`,
  }),
  "relire-apres-revocation": Object.freeze({
    titre: "Votre coffre doit être relu",
    corps:
      "La révocation a été faite. Mais votre coffre n'a pas pu relire ce qu'il contient : cet écran " +
      `ne peut plus dire quels moyens l'ouvrent encore, ni si votre feuille est toujours juste. ${ROUVRIR_LE_COFFRE}`,
  }),
  "revoquer-en-cours": Object.freeze({
    titre: "Révocation en cours",
    corps:
      "La demande est partie et ne peut plus être annulée : elle a peut-être déjà eu lieu. " +
      "Attendez la réponse du coffre.",
  }),
  "revocation-en-cours": Object.freeze({
    titre: null,
    corps:
      "Une révocation est en cours : elle a peut-être déjà eu lieu, et elle ne peut plus être annulée.",
  }),
  "revocation-incertaine": Object.freeze({
    titre: "Révocation à vérifier",
    corps:
      "La révocation est partie, mais le coffre ne l'a pas confirmée : elle a peut-être eu lieu. " +
      "Rouvrez votre coffre : si l'un des moyens que vous vouliez retirer l'ouvre encore, refaites " +
      "la révocation. Tant que vous ne l'avez pas vérifié, aucune nouvelle révocation n'est offerte.",
  }),
  termine: Object.freeze({
    titre: "Parcours terminé",
    corps:
      "La révocation a été faite : seul le moyen que vous avez utilisé pour ouvrir ce coffre " +
      "l'ouvre désormais. Les sauvegardes déjà faites restent ouvrables par les anciens moyens : " +
      "détruisez-les si elles risquent de tomber entre de mauvaises mains, puis faites une " +
      "nouvelle sauvegarde. Notez sur votre feuille le nouveau numéro de feuille.",
  }),
  "termine-sans-attestation": Object.freeze({
    titre: "Parcours terminé",
    corps:
      `${SEANCE} Cette page ne sait pas ce qui a pu être fait avant : elle ne l'affirme ni ne le ` +
      "nie. Les moyens qui ouvrent ce coffre sont ceux que vous voyez en le rouvrant.",
  }),
  "termine-sans-revoquer": Object.freeze({
    titre: "Parcours terminé",
    corps:
      `${SEANCE} Vous avez fait le tour de votre coffre sans révoquer. Si un jour l'un de ses ` +
      "moyens d'ouverture a pu être vu, la révocation reste disponible sur l'écran de votre " +
      "application.",
  }),
  annulee: Object.freeze({
    titre: null,
    corps: `Confirmation annulée. ${SEANCE}`,
  }),
  "envoi-annule-affichage": Object.freeze({
    titre: null,
    corps:
      "La demande n'a pas été envoyée : l'affichage de votre coffre n'a pas pu être protégé " +
      `d'abord. ${SEANCE}`,
  }),
  "lancement-annule-affichage": Object.freeze({
    titre: null,
    corps:
      "La demande n'a pas été lancée : l'affichage de votre coffre n'a pas pu être protégé d'abord. " +
      "Rien n'a été modifié par cette demande.",
  }),
  "indice-non-ecrit": Object.freeze({
    titre: null,
    corps:
      "La révocation a été faite, mais cette page n'a pas pu l'inscrire dans sa progression : " +
      "cela ne change rien à votre coffre.",
  }),
  "demande-refusee-en-cours": Object.freeze({
    titre: null,
    corps:
      "Une révocation est déjà en cours : elle a peut-être déjà eu lieu. Attendez la réponse du coffre.",
  }),
  "demande-refusee-a-verifier": Object.freeze({
    titre: null,
    corps:
      "Une révocation précédente n'a pas été confirmée : elle a peut-être eu lieu. Rouvrez votre " +
      "coffre pour le vérifier avant d'en demander une autre.",
  }),
  "demande-refusee-deja-faite": Object.freeze({
    titre: null,
    corps: "La révocation a déjà été faite dans cette séance : elle ne se refait pas.",
  }),
  "demande-refusee-donnees-inconnues": Object.freeze({
    titre: null,
    corps:
      "Cette page ne sait pas encore ce que contient votre coffre : patientez un instant, ou " +
      "rouvrez-le.",
  }),
  "geste-refuse": Object.freeze({
    titre: null,
    corps: "Ce geste n'est pas possible à cet instant.",
  }),
  "affichage-non-a-jour": Object.freeze({
    titre: null,
    corps:
      "L'affichage de votre coffre n'a pas pu être actualisé : ce qui s'affiche ici peut ne pas " +
      "être exact. Rechargez la page.",
  }),
});

/** Le texte d'une clé du catalogue ; une clé inconnue est une erreur de programmation. */
export function texteDe(cle) {
  const texte = TEXTES_PAR_CLE[cle];
  if (texte === undefined || CLES_DE_TEXTE[cle] === undefined) {
    throw new TypeError(`clé de texte inconnue : ${String(cle)}.`);
  }
  return texte;
}

/** L'étiquette d'une clé : ce qu'elle AFFIRME (D4). */
export function etiquetteDe(cle) {
  return CLES_DE_TEXTE[cle]?.affirme ?? null;
}

export { ETIQUETTES };
