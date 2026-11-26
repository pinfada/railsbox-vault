// Les ÉCRANS que la révocation d'urgence ajoute au parcours (#265, ADR 0049 § C2, D4). Aucun ne dit ce
// que la révocation a FAIT : ce que la page peut en affirmer est écrit par la VUE, dans le conteneur
// d'affichage, d'après l'état (`textes-de-la-revocation.mjs`). Ces écrans ne portent que des titres neutres
// et ce qui est attendu.

import { ecran } from "./fabrique-d-ecran.mjs";

/** La fin de la visite : ce qu'elle dit ne parle jamais de la révocation (D4). */
const FIN_DE_LA_VISITE = "Vous avez fait le tour de votre coffre.";
const POUR_REVENIR =
  "Pour vous servir de votre application, cliquez sur « Revenir à mon application ». Pour " +
  "recommencer le parcours depuis le début, effacez les données du site dans les réglages du " +
  "navigateur : supprimer les cookies ne suffit pas.";

export const ECRANS_DE_LA_REVOCATION = Object.freeze({
  // La fin d'une visite dont la personne a choisi de ne rien révoquer (#246). Cet écran ne dit RIEN de la
  // révocation : ce que la page peut en affirmer est dans la vue (`textes-de-la-revocation.mjs`, D4), et
  // l'annonce du geste dit « aucun geste de révocation dans cette séance ».
  "termine-sans-revoquer": ecran(9, {
    titre: "Parcours terminé",
    ceQuiVaSePasser: FIN_DE_LA_VISITE,
    attendu: POUR_REVENIR,
    blocs: ["retour"],
  }),
  // La fin après un ACQUIT du Worker : l'écran de l'ÉTAT (`K`). Son titre ne dit que « terminé » ; ce que la
  // révocation a fait est écrit par la vue, dans le conteneur d'affichage (D4, étiquette `revoque`).
  termine: ecran(9, {
    titre: "Parcours terminé",
    ceQuiVaSePasser: FIN_DE_LA_VISITE,
    attendu: POUR_REVENIR,
    blocs: ["impose", "retour"],
  }),
  // La fin atteinte par l'INDICE persisté seul, après un rechargement : la page ne sait rien de ce qui
  // s'est passé avant, et la vue ne dit que « aucun geste de révocation dans cette séance » (D4, S3).
  "termine-sans-attestation": ecran(9, {
    titre: "Parcours terminé",
    ceQuiVaSePasser: FIN_DE_LA_VISITE,
    attendu: POUR_REVENIR,
    blocs: ["fin", "retour"],
  }),
  // Ce que l'ÉTAT de la révocation impose : une lecture en échec, une modification, une demande en vol,
  // un doute, la fin après un acquit. Le texte est écrit par la VUE, dans le conteneur d'affichage.
  "etat-du-coffre": ecran(null, {
    titre: "Votre coffre",
    ceQuiVaSePasser:
      "Ce que votre coffre est en train de faire, et ce que cette page en sait, est écrit ci-dessous.",
    attendu: "Lisez le message ci-dessous : il dit quoi faire.",
    blocs: ["impose", "retour"],
  }),
});
