// Les textes des deux écrans « Votre coffre doit être relu » (relecture de #308) : une relecture de
// l'inventaire a ÉCHOUÉ, donc ni les moyens ni le constat de feuille ne sont connus, et aucun ne sert de
// garde. Seul le second parle de révocation, parce que seul le second suit une révocation ACQUITTÉE.

const ROUVRIR_LE_COFFRE =
  "Rouvrez votre coffre : rechargez la page, puis ouvrez-le avec le moyen que vous avez utilisé.";

export const ECRANS_DE_RELECTURE = Object.freeze({
  /** Hors de toute révocation (un déverrouillage ordinaire) : le texte n'en dit JAMAIS un mot. */
  relire: Object.freeze({
    titre: "Votre coffre doit être relu",
    ceQuiVaSePasser:
      "Votre coffre n'a pas pu relire ce qu'il contient : cet écran ne peut plus dire quels moyens " +
      "l'ouvrent, ni si votre feuille est toujours juste.",
    attendu: ROUVRIR_LE_COFFRE,
    blocs: Object.freeze([]),
  }),
  /** Une révocation ACQUITTÉE, puis une relecture échouée : le succès tient, le reste n'est plus connu. */
  apresRevocation: Object.freeze({
    titre: "Votre coffre doit être relu",
    ceQuiVaSePasser:
      "La révocation a été faite. Mais votre coffre n'a pas pu relire ce qu'il contient : cet écran ne " +
      "peut plus dire quels moyens l'ouvrent encore, ni si votre feuille est toujours juste.",
    attendu: ROUVRIR_LE_COFFRE,
    blocs: Object.freeze([]),
  }),
});
