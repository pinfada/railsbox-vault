// Les CONDUITES du DÉPHASAGE de versions (#236 T2, ADR 0042) : ce qu'une personne lit quand
// l'ouverture d'un coffre est refusée parce que l'origine ne sert pas — ou plus, ou pas encore — ce
// que ses données demandent.
//
// Scindé de `conduites-du-parcours.mjs`, inscrit sous surveillance de taille (#239) : six codes neufs
// et leurs phrases y auraient ajouté soixante lignes. Ce module ne rend qu'un FRAGMENT de la table ;
// le cliquet (`coquille-parcours-conduites.test.mjs`) le lit à travers elle, comme les autres.
// Aucune de ces conduites ne propose d'effacer quoi que ce soit.

import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

/** Les codes du déphasage, sur le chemin du démarrage (constatés à l'ouverture, redits au geste). */
export const CODES_DU_DEPHASAGE = Object.freeze([
  C.applicationEtrangere,
  C.applicationNonServie,
  C.applicationAnterieure,
  C.schemaDuCoffreInconnu,
  C.schemaDivergent,
  C.migrationEchouee,
  // Revue de sécurité de la PR #249 : la reprise par version, et les refus neufs du guest.
  C.miseAJourInterrompue,
  C.marqueurDeSchemaInvalide,
  C.parametreDuGuestRefuse,
  C.migrationNonAutorisee,
]);

const SAUVEGARDE_SANS_DEMARRER =
  " Vous pouvez aussi en faire une sauvegarde : elle se fait sans démarrer l'application.";

/**
 * Le fragment de table : pour chaque code, sa CLASSE et sa phrase. Les classes et « rien n'a été
 * perdu » sont PASSÉS par la table qui l'accueille, pour qu'aucun des deux modules n'importe l'autre.
 *
 * @param {Record<string, string>} K les classes de conduite
 * @param {string} RIEN_PERDU
 */
export function conduitesDuDephasage(K, RIEN_PERDU) {
  return {
    [C.applicationEtrangere]: [
      K.autre,
      "Ce coffre contient les données d'une autre application que celle que cette adresse propose. " +
        "Rien n'a été démarré ni modifié : vos données sont intactes dans ce navigateur. Rouvrez ce " +
        "coffre depuis l'adresse qui sert son application." +
        SAUVEGARDE_SANS_DEMARRER,
    ],
    [C.applicationNonServie]: [
      K.autre,
      "Vos données sont intactes dans ce navigateur, mais cette adresse ne sert pas l'application " +
        "dont elles ont besoin, ou plus sa version. Rouvrez ce coffre depuis une adresse qui la sert, " +
        "ou, si « Mettre à jour l'application » vous est proposé, mettez à jour." +
        SAUVEGARDE_SANS_DEMARRER,
    ],
    [C.applicationAnterieure]: [
      K.attendre,
      "Vos données viennent d'une version plus récente de l'application que celle que cette adresse " +
        "sert. Rien n'a été démarré ni modifié. Rouvrez ce coffre plus tard, ou depuis une adresse " +
        "qui sert la version récente." +
        SAUVEGARDE_SANS_DEMARRER,
    ],
    [C.schemaDuCoffreInconnu]: [
      K.autre,
      "Ce coffre a été créé par une version de l'application que cette adresse ne sert plus, et " +
        "l'état exact de ses données ne peut pas être vérifié ici. Rien n'a été démarré ni modifié. " +
        "Rouvrez-le depuis une adresse qui sert cette version." +
        SAUVEGARDE_SANS_DEMARRER,
    ],
    [C.miseAJourInterrompue]: [
      K.attendre,
      "Une mise à jour de l'application a commencé sur ce coffre et n'a pas pu se terminer. Elle ne " +
        "peut reprendre qu'avec la version visée ou une plus récente, que cette adresse ne sert pas. " +
        "Rien n'a été démarré ni modifié. Rouvrez ce coffre plus tard, ou depuis une adresse qui sert " +
        "cette version." +
        SAUVEGARDE_SANS_DEMARRER,
    ],
    ...conduitesDuGuest(K, RIEN_PERDU),
  };
}

/**
 * Les conduites des refus que le GUEST constate avant Rails (marqueurs, paramètres, migration).
 * Scindées de `conduitesDuDephasage` pour rester sous le plafond de fonction (#93).
 *
 * @param {Record<string, string>} K @param {string} RIEN_PERDU
 */
function conduitesDuGuest(K, RIEN_PERDU) {
  return {
    [C.schemaDivergent]: [
      K.autre,
      "L'application n'a pas été lancée : l'état de vos données ne correspond pas à ce que le " +
        "coffre annonçait, le plus souvent après une mise à jour interrompue. " +
        RIEN_PERDU +
        " Si « Mettre à jour l'application » vous est proposé, utilisez-le pour reprendre la mise à " +
        "jour ; sinon, restaurez la sauvegarde faite avant.",
    ],
    [C.migrationEchouee]: [
      K.autre,
      "La mise à jour de vos données a échoué, et l'application n'a pas été lancée. Ce qui était " +
        "enregistré avant la mise à jour n'a pas été perdu. Rouvrez le coffre sur l'ancienne version " +
        "avec « Plus tard » s'il vous est proposé, ou restaurez la sauvegarde faite avant, et " +
        "signalez l'échec à l'auteur de l'application.",
    ],
    [C.marqueurDeSchemaInvalide]: [
      K.autre,
      "L'application n'a pas été lancée : une indication sur l'état de vos données est illisible. " +
        "Rien n'a été modifié ni migré. N'effacez rien : gardez ce coffre, faites-en une sauvegarde, " +
        "et demandez de l'aide." +
        SAUVEGARDE_SANS_DEMARRER,
    ],
    [C.parametreDuGuestRefuse]: [
      K.autre,
      "L'application n'a pas été lancée : cette adresse lui a transmis un réglage qu'elle n'a pas le " +
        "droit de fixer. " +
        RIEN_PERDU +
        " Rouvrez ce coffre depuis une autre adresse, ou signalez le problème à qui publie cette " +
        "application.",
    ],
    [C.migrationNonAutorisee]: [
      K.autre,
      "L'application n'a pas été lancée : elle aurait dû transformer vos données alors que vous ne " +
        "l'avez pas demandé. " +
        RIEN_PERDU +
        " Si « Mettre à jour l'application » vous est proposé, utilisez-le ; sinon, signalez le " +
        "problème à qui publie cette application.",
    ],
  };
}
