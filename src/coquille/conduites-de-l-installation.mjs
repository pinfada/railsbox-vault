// Les CONDUITES d'une installation qui n'a pas abouti (#250) : ce qu'une personne lit quand le premier
// démarrage de son application n'a pas pu se terminer, ou quand le coffre porte un disque d'application
// que la coquille ne sait pas identifier.
//
// Un FRAGMENT de la table de `conduites-du-parcours.mjs`, comme `conduites-du-dephasage.mjs` : le
// cliquet (`coquille-parcours-conduites.test.mjs`) le lit à travers elle. Aucune de ces conduites ne
// propose d'effacer quoi que ce soit, et chacune ne nomme que des boutons que l'étape 4 offre alors
// (`accueil-de-la-mise-a-jour.mjs`, `gestesDAbri`).

import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

/**
 * Le fragment de table : pour chaque code, sa CLASSE et sa phrase. Les classes sont PASSÉES par la
 * table qui l'accueille, pour qu'aucun des deux modules n'importe l'autre.
 *
 * @param {Record<string, string>} K les classes de conduite
 */
export function conduitesDeLInstallation(K) {
  return {
    // L'installation RECONNUE : la signature tient (graine) ou le volume n'a jamais démarré (boot).
    [C.installationInachevee]: [
      K.recommencer,
      "L'installation de votre application n'a pas pu se terminer. Rien n'est perdu : votre coffre " +
        "ne contient encore aucune donnée de l'application. Cliquez sur « Reprendre l'installation ». " +
        "Si cela recommence, cette adresse ne sert pas correctement l'application : vous pouvez " +
        "alors verrouiller votre coffre, et réessayer plus tard.",
    ],
    // Le volume a SERVI : l'adresse n'a pas fourni l'application, et il n'y a rien à reprendre (#255).
    [C.artefactDuDemarrageRefuse]: [
      K.attendre,
      "Cette adresse n'a pas pu fournir l'application (téléchargement refusé, interrompu ou " +
        "altéré). Vos données sont intactes dans votre coffre : rien n'a été démarré ni modifié. " +
        "Réessayez plus tard ; si cela recommence, c'est cette adresse qui ne sert pas " +
        "correctement l'application.",
    ],
    // L'état AMBIGU : un disque anonyme que rien ne prouve être une installation interrompue.
    [C.volumeApplicatifSansManifeste]: [
      K.autre,
      "Votre coffre contient déjà un disque d'application dont l'état ne peut pas être vérifié ici. " +
        "Rien n'a été effacé ni modifié. N'effacez rien : verrouillez votre coffre, puis demandez " +
        "de l'aide.",
    ],
  };
}
