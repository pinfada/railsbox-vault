// Les CONDUITES du parcours guidé (#193, ADR 0040) : ce qu'une personne lit quand un geste est refusé.
//
// Les conduites de `interface-de-deverrouillage.mjs` et les messages de `refus-de-coquille.mjs`
// parlent à un exploitant : ils nomment l'enveloppe, le plancher de rejeu, le Worker de confiance. Ils
// RESTENT — sous « détails techniques », et dans les épreuves qui les lisent. Ce module ajoute une
// seconde table, écrite pour quelqu'un qui ne connaît ni le vocabulaire du dépôt ni la cryptographie :
// ce qui s'est passé, si quelque chose a été perdu, et ce qu'il peut faire maintenant.
//
// ## Le cliquet, PAR CONSTRUCTION (revue de la PR #213, constat 4)
//
// `tests/unit/coquille-parcours-conduites.test.mjs` énumère les codes depuis les listes EXPORTÉES —
// coquille, stockage, enveloppe, dérivation, archive, import — et non depuis une liste recopiée ici.
// Chaque code y est soit sur le chemin (`CODES_DU_CHEMIN`), avec sa conduite et son CLASSEMENT, soit
// écarté NOMMÉMENT (`CODES_HORS_DU_CHEMIN`) par un motif qui commence par « inatteignable depuis le
// parcours parce que ». Un code neuf dans une de ces familles fait rougir l'épreuve. Avant la revue,
// le cliquet ne classait que la coquille, l'archive et l'import : vingt et un codes du stockage et de
// l'enveloppe, que le démarrage remonte tels quels, arrivaient à la phrase générique.
//
// ## Ce que ce module ne décide pas
//
// Aucun refus. Il ne change ni un code, ni une garde, ni l'ordre d'un geste : il traduit.

import { ARCHIVE_ERROR_CODES } from "../vm/archive-errors.mjs";
import { DERIVATION_ERROR_CODES } from "../vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../vm/enveloppe/enveloppe-errors.mjs";
import { IMPORT_ERROR_CODES } from "../vm/import-errors.mjs";
import { STORAGE_ERROR_CODES as S } from "../vm/storage-errors.mjs";
import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

const E = ENVELOPPE_ERROR_CODES;
const D = DERIVATION_ERROR_CODES;
const A = ARCHIVE_ERROR_CODES;
const I = IMPORT_ERROR_CODES;

const RIEN_PERDU = "Rien n'a été perdu.";
const REESSAYER_PLUS_TARD =
  "Rechargez la page puis réessayez. Si cela se reproduit, notez le détail technique ci-dessous " +
  "et demandez de l'aide.";
const CHROME_OU_EDGE = "Essayez un autre navigateur récent : Chrome ou Edge.";
const RESTAURER_AILLEURS =
  "N'effacez rien. Si vous avez une sauvegarde, restaurez-la dans un autre navigateur ou à une " +
  "autre adresse.";

/** La conduite d'un refus que la table ne connaît pas : humaine, et le détail reste technique. */
export const CONDUITE_GENERIQUE = "L'opération a été refusée. " + REESSAYER_PLUS_TARD;

/**
 * Les codes que chaque geste du parcours peut rendre, groupés par geste. Un code peut appartenir à
 * plusieurs gestes : la liste dit où on le rencontre, la table dit ce qu'on en lit.
 */
export const CODES_DU_CHEMIN = Object.freeze({
  deverrouillage: Object.freeze([
    E.cleRefusee,
    E.rejeu,
    E.absente,
    E.illisible,
    E.identite,
    E.troncature,
    E.melange,
    E.malforme,
    E.racineRefusee,
    E.pleine,
    E.presente,
    D.typeInconnu,
    D.parametresRefuses,
    D.phraseRefusee,
    D.prfIndisponible,
    D.prfIgnoree,
    D.annulee,
    D.codeMalRecopie,
    D.codeDejaRendu,
    D.argon2Indisponible,
    S.unsupported,
    S.busy,
    S.quotaExceeded,
    S.volumeSansRacine,
    S.engagementInvalide,
    S.creationNonConfirmee,
    S.identiteVolume,
    S.cleRequise,
    S.volumeIncomplet,
    S.sceauRefuse,
    S.domaineAbsentDuFormat,
    C.volumeVerrouille,
    C.coffreAnterieur,
    C.disqueDUnAutreCoffre,
    C.coffreServiSansManifeste,
    C.restaurationInterrompue,
    C.capaciteManquante,
    C.messageMalforme,
    C.workerMort,
    C.gesteRompu,
  ]),
  cycle: Object.freeze([
    C.etapeHorsOrdre,
    C.applicationAbsente,
    C.gesteEnCours,
    C.volumeVerrouille,
    C.disqueDUnAutreCoffre,
    S.busy,
    S.quotaExceeded,
    // Le démarrage ouvre le volume de l'application : tout code typé du stockage remonte tel quel
    // (`public/runtime-worker.mjs`), et ceux-ci sont ceux que l'ouverture et l'écriture lèvent.
    S.outOfRange,
    S.shortRead,
    S.partialWrite,
    S.closed,
    S.geometryMismatch,
    S.supportFailure,
    S.generationDiscarded,
    S.generationCorrupt,
    S.generationOverflow,
    S.generationPending,
    S.generationRootCorrupt,
    S.sceauRefuse,
    S.budgetDeCle,
    S.lectureSeule,
    S.cleRequise,
    S.volumeIncomplet,
    S.quiesce,
    C.workerMort,
    C.gesteRompu,
  ]),
  relais: Object.freeze([
    C.applicationNonDemarree,
    C.requeteHttpRefusee,
    C.reponseHttpTropGrande,
    C.relaisAbandonne,
    C.workerMort,
    C.gesteRompu,
  ]),
  installationInterrompue: Object.freeze([
    C.volumeApplicatifSansManifeste,
    S.creationNonConfirmee,
    C.gesteRompu,
  ]),
  verrouillage: Object.freeze([
    C.etapeHorsOrdre,
    S.flushFailed,
    S.handleLost,
    S.quiesce,
    S.closed,
    C.workerMort,
    C.gesteRompu,
  ]),
  sauvegarde: Object.freeze([
    C.volumeVerrouille,
    C.applicationNonInstallee,
    C.gesteEnCours,
    C.disqueDUnAutreCoffre,
    S.quotaExceeded,
    C.workerMort,
    C.gesteRompu,
  ]),
  restauration: Object.freeze([
    C.emplacementOccupe,
    C.archiveDUnAutreCoffre,
    C.archiveSansRecuperation,
    C.restaurationInterrompue,
    C.coffreServiSansManifeste,
    C.gesteEnCours,
    C.messageMalforme,
    A.malformed,
    A.truncated,
    A.digestMismatch,
    A.geometryMismatch,
    A.recuperationAlteree,
    A.recuperationRefusee,
    A.versionNonLue,
    A.engagementAbsent,
    I.targetNotEmpty,
    I.spaceInsufficient,
    I.geometryMismatch,
    I.verificationFailed,
    S.quotaExceeded,
    C.workerMort,
    C.gesteRompu,
  ]),
  revocation: Object.freeze([
    C.volumeVerrouille,
    C.gesteEnCours,
    E.dernierEmplacement,
    E.emplacementInconnu,
    C.workerMort,
    C.gesteRompu,
  ]),
});

const INATTEIGNABLE = "inatteignable depuis le parcours parce que ";

/**
 * Les codes qui NE SONT PAS sur le chemin, chacun avec son motif. Une exclusion est une décision
 * écrite, jamais un oubli ; son motif dit POURQUOI aucun geste de la personne ne la produit.
 */
export const CODES_HORS_DU_CHEMIN = Object.freeze({
  [C.contratRefuse]: `${INATTEIGNABLE}seul le document applicatif d'un autre dialecte le reçoit, sur le port restreint`,
  [C.typeInconnu]: `${INATTEIGNABLE}c'est un message hors contrat, jamais un geste de la page`,
  [C.kek]: `${INATTEIGNABLE}c'est l'application qui demande une clé, sur le port restreint`,
  [C.dek]: `${INATTEIGNABLE}c'est l'application qui demande une clé, sur le port restreint`,
  [C.exportation]: `${INATTEIGNABLE}c'est l'application qui demande l'export, sur le port restreint`,
  [C.revocation]: `${INATTEIGNABLE}c'est l'application qui demande une révocation, sur le port restreint`,
  [C.emplacement]: `${INATTEIGNABLE}c'est l'application qui ajoute un moyen, sur le port restreint`,
  [C.recuperation]: `${INATTEIGNABLE}c'est l'application qui crée un moyen, sur le port restreint`,
  [C.volume]: `${INATTEIGNABLE}c'est l'application qui choisit un volume, sur le port restreint`,
  [C.enveloppe]: `${INATTEIGNABLE}c'est l'application qui lit l'enveloppe, sur le port restreint`,
  [C.portPrivilegie]: `${INATTEIGNABLE}c'est l'application qui vise le canal privilégié`,
  [C.handle]: `${INATTEIGNABLE}c'est l'application qui demande un handle, sur le port restreint`,
  [C.canalAbsent]: `${INATTEIGNABLE}c'est un ordre interne de l'annonce du cadre, jamais un geste`,
  [C.annonceType]: `${INATTEIGNABLE}il juge l'annonce du cadre, pas un geste de la personne`,
  [C.annonceOrigine]: `${INATTEIGNABLE}il juge l'annonce du cadre, pas un geste de la personne`,
  [C.annonceFenetre]: `${INATTEIGNABLE}il juge l'annonce du cadre, pas un geste de la personne`,
  [C.annonceUnique]: `${INATTEIGNABLE}il juge l'annonce du cadre, pas un geste de la personne`,
  [C.correlationAbsente]: `${INATTEIGNABLE}c'est un défaut de programmation du contrat, compté au relevé`,
  [C.correlationDupliquee]: `${INATTEIGNABLE}c'est un défaut de programmation du contrat, compté au relevé`,
  [C.tropDeRequetes]: `${INATTEIGNABLE}c'est l'application qui inonde la coquille, sur le port restreint`,
  [C.capaciteDansUnMessage]: `${INATTEIGNABLE}la capacité est refusée avant l'envoi, par le contrat`,
  [C.canalDeRelaisRefuse]: `${INATTEIGNABLE}c'est l'application qui vise le canal de relais`,
  [I.consentementRequis]: `${INATTEIGNABLE}la restauration sans feuille (ADR 0027) n'est pas offerte par la coquille`,
});

/** Les CLASSES de conduite : ce que la personne fera, en un mot. La page de relecture les affiche. */
export const CLASSES_DE_CONDUITE = Object.freeze({
  recommencer: "recommencer",
  recopier: "recopier",
  attendre: "attendre",
  abandonner: "abandonner ce coffre",
  autreAppareil: "autre appareil ou autre navigateur",
  autre: "autre conduite, dite dans le message",
});

const K = CLASSES_DE_CONDUITE;

/**
 * La table des conduites, écrite pour une personne : pour chaque code, sa CLASSE et sa phrase (parfois
 * trois).
 */
const TABLE = Object.freeze({
  // --- Ouvrir ------------------------------------------------------------------------------------
  [E.cleRefusee]: [
    K.recopier,
    "Ce que vous avez présenté n'ouvre pas ce coffre : la phrase est peut-être mal tapée (majuscules, " +
      "accents, espaces), ou ce n'est pas le bon code. " +
      RIEN_PERDU +
      " Réessayez tranquillement : il n'y a pas de nombre d'essais limité.",
  ],
  [E.rejeu]: [
    K.recopier,
    "Le numéro de version que vous avez tapé est plus grand que celui de ce coffre. Relisez le " +
      "numéro sur votre feuille. Si vous n'êtes pas sûr, videz ce champ et réessayez : le coffre " +
      "s'ouvrira, mais sans vérifier qu'on ne lui a pas remis une copie plus ancienne.",
  ],
  [E.absente]: [
    K.autre,
    "Il n'y a pas de coffre sur cet appareil. Si vous en avez créé un ailleurs, restaurez sa " +
      "sauvegarde ici.",
  ],
  [E.illisible]: [
    K.autreAppareil,
    "Le fichier qui protège ce coffre sur cet appareil est abîmé. " + RESTAURER_AILLEURS,
  ],
  [E.identite]: [
    K.autreAppareil,
    "Le fichier qui protège ce coffre ne correspond pas à ce coffre. " + RESTAURER_AILLEURS,
  ],
  [E.troncature]: [
    K.autreAppareil,
    "Le fichier qui protège ce coffre est incomplet sur cet appareil. " + RESTAURER_AILLEURS,
  ],
  [E.melange]: [
    K.autreAppareil,
    "Le fichier qui protège ce coffre a été assemblé à partir de deux copies différentes. " +
      RESTAURER_AILLEURS,
  ],
  [E.malforme]: [
    K.autreAppareil,
    "Le fichier qui protège ce coffre n'est pas lisible. " + RESTAURER_AILLEURS,
  ],
  [E.racineRefusee]: [
    K.autreAppareil,
    "Ce coffre ne peut pas prouver que son contenu est intact. Ne l'utilisez pas. " +
      RESTAURER_AILLEURS,
  ],
  [E.pleine]: [
    K.autre,
    "Ce coffre a déjà le nombre maximal de moyens de l'ouvrir : rien n'a été ajouté. " + RIEN_PERDU,
  ],
  [E.presente]: [
    K.recommencer,
    "Un coffre existe déjà sur cet appareil : rien n'a été écrasé. Rechargez la page, et ouvrez le " +
      "coffre existant.",
  ],
  [D.typeInconnu]: [
    K.autre,
    "Ce coffre a été fermé par une version plus récente de RailsBox Vault. Mettez l'application à " +
      "jour, puis réessayez. " +
      RIEN_PERDU,
  ],
  [D.parametresRefuses]: [
    K.autre,
    "Les réglages enregistrés pour ouvrir ce coffre ne sont pas acceptables : ce coffre a peut-être " +
      "été modifié. " +
      RIEN_PERDU +
      " Ouvrez-le par votre code de récupération, ou restaurez votre sauvegarde.",
  ],
  [D.phraseRefusee]: [
    K.recopier,
    "Le champ de la phrase est vide. Tapez une phrase de plusieurs mots, facile à retenir pour vous " +
      "et difficile à deviner pour les autres.",
  ],
  [D.prfIndisponible]: [
    K.autre,
    "Cette passkey ne sait pas protéger un coffre. Utilisez une phrase, ou une autre passkey.",
  ],
  [D.prfIgnoree]: [
    K.autre,
    "L'appareil a reconnu votre passkey mais n'a pas rendu ce qu'il fallait pour ouvrir le coffre. " +
      "Utilisez une phrase, ou une autre passkey.",
  ],
  [D.annulee]: [
    K.recommencer,
    "La demande a été annulée, ou personne n'y a répondu à temps. " +
      RIEN_PERDU +
      " Vous pouvez recommencer.",
  ],
  [D.codeMalRecopie]: [
    K.recopier,
    "Le code a une faute de recopie : une lettre ou un chiffre est mal lu, ou deux sont inversés. " +
      "Relisez votre feuille, symbole par symbole. Les tirets, les espaces et les majuscules n'ont " +
      "pas d'importance.",
  ],
  [D.codeDejaRendu]: [
    K.recopier,
    "Le code de récupération ne s'affiche qu'une fois, et il a déjà été affiché. Il ne le sera pas " +
      "de nouveau : ouvrez le coffre avec le code de votre feuille pour le vérifier.",
  ],
  [D.argon2Indisponible]: [
    K.autreAppareil,
    "Ce navigateur ne peut pas faire le calcul qui protège le coffre. " + CHROME_OU_EDGE,
  ],
  [S.unsupported]: [
    K.autreAppareil,
    "Ce navigateur ne sait pas garder un coffre. " + CHROME_OU_EDGE + " " + RIEN_PERDU,
  ],
  [S.busy]: [
    K.recommencer,
    "Ce coffre est déjà ouvert dans un autre onglet ou une autre fenêtre. Fermez l'autre onglet, " +
      "puis réessayez ici.",
  ],
  [S.quotaExceeded]: [
    K.recommencer,
    "Il n'y a plus assez de place pour ce coffre dans ce navigateur. Libérez de l'espace sur " +
      "l'appareil, puis réessayez.",
  ],
  [S.volumeSansRacine]: [
    K.recommencer,
    "La restauration de ce coffre n'est pas allée jusqu'au bout. Restaurez à nouveau la sauvegarde, " +
      "puis ouvrez le coffre tout de suite après.",
  ],
  [S.engagementInvalide]: [
    K.autreAppareil,
    "Le contenu de ce coffre ne correspond pas à sa sauvegarde : il a été modifié. Ne l'utilisez " +
      "pas ; restaurez une sauvegarde en laquelle vous avez confiance.",
  ],
  [S.creationNonConfirmee]: [
    K.recommencer,
    "L'installation n'a pas pu être vérifiée sur cet appareil. Rien n'est déclaré installé : " +
      "recommencez.",
  ],
  [S.identiteVolume]: [
    K.autreAppareil,
    "Les données de ce coffre ne lui appartiennent pas. " + RESTAURER_AILLEURS,
  ],
  [S.cleRequise]: [
    K.recommencer,
    "Le coffre doit d'abord être ouvert pour faire cela. Rouvrez-le, puis recommencez.",
  ],
  [S.volumeIncomplet]: [
    K.recommencer,
    "La préparation des données de ce coffre a été interrompue avant la fin : rien de ce que vous " +
      "aviez enregistré n'a été touché. Rechargez la page puis réessayez ; si le bouton « Reprendre " +
      "l'installation » apparaît, utilisez-le.",
  ],
  [S.sceauRefuse]: [
    K.autreAppareil,
    "Les données de ce coffre sur cet appareil ont été abîmées ou modifiées : rien n'en a été lu. Ne " +
      "l'utilisez pas. " +
      RESTAURER_AILLEURS,
  ],
  [S.domaineAbsentDuFormat]: [
    K.autre,
    "Ce coffre a un format que cette version de RailsBox Vault ne sait pas utiliser pour cette " +
      "opération. " +
      RIEN_PERDU +
      " Notez le détail technique ci-dessous et demandez de l'aide.",
  ],
  [C.volumeVerrouille]: [
    K.recommencer,
    "Le coffre doit d'abord être ouvert pour faire cela. Ouvrez-le, puis recommencez.",
  ],
  [C.coffreAnterieur]: [
    K.abandonner,
    "Ce coffre a été créé par une version d'essai antérieure au 13 septembre 2026, que cette version " +
      "ne sait pas ouvrir. Pour repartir de zéro : dans les réglages du navigateur, effacez les données " +
      "de ce site, rechargez la page, puis créez un nouveau coffre. Ce qui était dans l'ancien coffre " +
      "sera effacé.",
  ],
  [C.disqueDUnAutreCoffre]: [
    K.abandonner,
    "L'application enregistrée sur cet appareil n'appartient pas à ce coffre. Rien n'a été ouvert ni " +
      "modifié. Pour repartir d'un emplacement vide, effacez les données de ce site dans les réglages " +
      "du navigateur, puis restaurez la sauvegarde de votre coffre.",
  ],
  [C.coffreServiSansManifeste]: [
    K.autre,
    "Ce coffre a été utilisé après sa restauration, puis une partie de ses informations a disparu. " +
      "Le réparer effacerait ce que vous y avez écrit depuis : rien n'a été touché. N'effacez pas les " +
      "données de ce site, gardez votre sauvegarde, et demandez de l'aide.",
  ],
  [C.restaurationInterrompue]: [
    K.recommencer,
    "Une restauration a été interrompue avant la fin : le coffre n'est pas prêt. Choisissez de " +
      "nouveau le même fichier de sauvegarde et relancez la restauration.",
  ],
  [C.capaciteManquante]: [
    K.autreAppareil,
    "Ce navigateur n'offre pas tout ce dont le coffre a besoin. " + CHROME_OU_EDGE,
  ],
  [C.messageMalforme]: [
    K.recopier,
    "Ce qui a été saisi ou choisi n'a pas la forme attendue : le numéro de version est un nombre " +
      "entier, et une restauration demande un fichier de sauvegarde. Corrigez, puis réessayez.",
  ],
  [C.workerMort]: [
    K.recommencer,
    "Le coffre a cessé de répondre. Par sécurité, il ne fait plus rien tant que vous ne l'avez pas " +
      "rouvert. Ce qui a été enregistré avant reste enregistré. Cliquez sur « Rouvrir le coffre ».",
  ],
  [C.gesteRompu]: [
    K.recommencer,
    "L'opération n'a pas abouti, sans cause identifiée. " + REESSAYER_PLUS_TARD,
  ],

  // --- L'application -----------------------------------------------------------------------------
  [C.etapeHorsOrdre]: [
    K.attendre,
    "Une autre opération est en cours, ou le coffre n'est pas encore ouvert. Attendez la fin de " +
      "l'opération en cours, puis recommencez.",
  ],
  [C.applicationAbsente]: [
    K.autre,
    "Aucune application n'est livrée avec ce coffre à cette adresse : il n'y a rien à démarrer.",
  ],
  [C.gesteEnCours]: [
    K.attendre,
    "Une opération longue est déjà en cours (démarrage, sauvegarde ou restauration). Attendez " +
      "qu'elle se termine, puis recommencez.",
  ],
  [C.volumeApplicatifSansManifeste]: [
    K.recommencer,
    "Une installation précédente a été interrompue avant la fin. Rien n'a été écrasé. Si le bouton " +
      "« Reprendre l'installation » apparaît, utilisez-le.",
  ],
  [C.applicationNonDemarree]: [
    K.recommencer,
    "L'application s'est arrêtée. Cliquez de nouveau sur « Démarrer l'application ».",
  ],
  [C.requeteHttpRefusee]: [
    K.recommencer,
    "L'application a demandé quelque chose que le coffre ne transmet pas. Revenez à la page " +
      "précédente de l'application et réessayez.",
  ],
  [C.reponseHttpTropGrande]: [
    K.autre,
    "La page demandée à l'application est trop volumineuse pour être affichée ici.",
  ],
  [C.relaisAbandonne]: [
    K.recommencer,
    "La page n'a pas été affichée parce que le coffre venait d'être verrouillé. Rouvrez le coffre " +
      "pour continuer.",
  ],
  [S.outOfRange]: [
    K.recommencer,
    "Le coffre a refusé une lecture ou une écriture incohérente : rien n'a été écrit à moitié. " +
      REESSAYER_PLUS_TARD,
  ],
  [S.shortRead]: [
    K.recommencer,
    "Le navigateur n'a pas pu relire toutes les données du coffre. " + REESSAYER_PLUS_TARD,
  ],
  [S.partialWrite]: [
    K.recommencer,
    "Le navigateur n'a pas pu enregistrer toutes les données du coffre : ce qui avait été confirmé " +
      "est conservé. Libérez de l'espace sur l'appareil, puis rechargez la page.",
  ],
  [S.closed]: [
    K.recommencer,
    "Le coffre a été refermé pendant l'opération. Rouvrez-le, puis recommencez.",
  ],
  [S.geometryMismatch]: [
    K.autreAppareil,
    "Les données de ce coffre sur cet appareil n'ont pas la taille attendue : rien n'a été modifié. " +
      RESTAURER_AILLEURS,
  ],
  [S.supportFailure]: [
    K.recommencer,
    "Le navigateur n'a pas pu lire ou écrire les données du coffre. " + REESSAYER_PLUS_TARD,
  ],
  [S.generationDiscarded]: [
    K.recommencer,
    "Les dernières modifications, qui n'avaient pas été confirmées avant une coupure, n'ont pas été " +
      "gardées. Ce qui avait été confirmé est conservé : continuez normalement.",
  ],
  [S.generationCorrupt]: [
    K.autreAppareil,
    "Une partie des données de ce coffre sur cet appareil est abîmée : rien n'a été deviné ni " +
      "réparé. Ne l'utilisez pas. " +
      RESTAURER_AILLEURS,
  ],
  [S.generationOverflow]: [
    K.recommencer,
    "L'application a voulu enregistrer trop de choses d'un seul coup : rien n'a été enregistré à " +
      "moitié. " +
      REESSAYER_PLUS_TARD,
  ],
  [S.generationPending]: [
    K.attendre,
    "Le coffre termine un enregistrement. Attendez quelques secondes, puis recommencez.",
  ],
  [S.generationRootCorrupt]: [
    K.autreAppareil,
    "Le coffre ne peut plus savoir quel est son dernier état enregistré sur cet appareil : rien n'a " +
      "été deviné. Ne l'utilisez pas. " +
      RESTAURER_AILLEURS,
  ],
  [S.budgetDeCle]: [
    K.autre,
    "Ce coffre a atteint une limite de sécurité que cette version de RailsBox Vault ne sait pas " +
      "encore renouveler. " +
      RIEN_PERDU +
      " Faites une sauvegarde, puis demandez de l'aide.",
  ],
  [S.lectureSeule]: [
    K.recommencer,
    "Le coffre n'a été ouvert ici que pour être lu, et cette opération doit écrire. Rechargez la page, " +
      "rouvrez le coffre, puis recommencez.",
  ],
  [S.quiesce]: [
    K.attendre,
    "Le coffre enregistre son état en ce moment. Attendez quelques secondes, puis recommencez.",
  ],

  // --- Verrouiller -------------------------------------------------------------------------------
  [S.flushFailed]: [
    K.recommencer,
    "Le coffre n'a pas pu confirmer l'enregistrement de vos dernières modifications. Par sécurité, " +
      "il est arrêté. Rouvrez-le : ce qui avait été confirmé est conservé.",
  ],
  [S.handleLost]: [
    K.recommencer,
    "Le navigateur a retiré au coffre l'accès à ses données. Par sécurité, il est arrêté. Rouvrez-le.",
  ],

  // --- Sauvegarder -------------------------------------------------------------------------------
  [C.applicationNonInstallee]: [
    K.recommencer,
    "Il n'y a encore rien à sauvegarder : démarrez l'application une première fois.",
  ],

  // --- Restaurer ---------------------------------------------------------------------------------
  [C.emplacementOccupe]: [
    K.autreAppareil,
    "Cet appareil a déjà un coffre à cette adresse. On ne restaure jamais par-dessus un coffre " +
      "existant : restaurez à une autre adresse, dans un autre navigateur, ou sur un autre appareil.",
  ],
  [C.archiveDUnAutreCoffre]: [
    K.recommencer,
    "Ce fichier n'est pas une sauvegarde de coffre RailsBox Vault. Rien n'a été écrit. Choisissez le " +
      "fichier enregistré par « Sauvegarder mon coffre ».",
  ],
  [C.archiveSansRecuperation]: [
    K.autre,
    "Cette sauvegarde a été faite sans code de récupération : elle ne peut s'ouvrir nulle part " +
      "ailleurs. Rien n'a été écrit.",
  ],
  [A.malformed]: [
    K.recommencer,
    "Ce fichier n'est pas une sauvegarde lisible. Rien n'a été écrit. Choisissez le fichier " +
      "enregistré par « Sauvegarder mon coffre ».",
  ],
  [A.truncated]: [
    K.recommencer,
    "Ce fichier de sauvegarde est incomplet, souvent à cause d'un téléchargement ou d'une copie " +
      "interrompus. Rien n'a été écrit. Enregistrez ou copiez de nouveau la sauvegarde.",
  ],
  [A.digestMismatch]: [
    K.recommencer,
    "Cette sauvegarde a été abîmée ou modifiée depuis qu'elle a été faite : son contenu ne " +
      "correspond plus. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.",
  ],
  [A.geometryMismatch]: [
    K.recommencer,
    "Cette sauvegarde est incohérente. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.",
  ],
  [A.recuperationAlteree]: [
    K.recommencer,
    "La partie de cette sauvegarde qui permet de l'ouvrir par le code a été abîmée. Rien n'a été " +
      "écrit. Utilisez une autre copie de la sauvegarde.",
  ],
  [A.recuperationRefusee]: [
    K.autre,
    "Cette sauvegarde ne s'ouvre pas par un code de récupération. Rien n'a été écrit.",
  ],
  [A.versionNonLue]: [
    K.autre,
    "Cette sauvegarde a été faite par une version différente de RailsBox Vault, que celle-ci ne sait " +
      "pas lire. Rien n'a été écrit.",
  ],
  [A.engagementAbsent]: [
    K.recommencer,
    "Cette sauvegarde ne permet pas de vérifier que son contenu est intact. Rien n'a été écrit. " +
      "Utilisez une sauvegarde faite par « Sauvegarder mon coffre ».",
  ],
  [I.targetNotEmpty]: [
    K.autreAppareil,
    "Cet appareil a déjà un coffre à cette adresse : rien n'a été écrit. Restaurez à une autre " +
      "adresse, dans un autre navigateur, ou sur un autre appareil.",
  ],
  [I.spaceInsufficient]: [
    K.recommencer,
    "Il n'y a pas assez de place dans ce navigateur pour restaurer cette sauvegarde. Rien n'a été " +
      "écrit. Libérez de l'espace sur l'appareil, puis réessayez.",
  ],
  [I.geometryMismatch]: [
    K.autre,
    "Cette sauvegarde ne correspond pas à ce que cet appareil attend. Rien n'a été écrit.",
  ],
  [I.verificationFailed]: [
    K.recommencer,
    "La sauvegarde a été copiée, mais la vérification de la copie a échoué. Le coffre n'est pas " +
      "prêt : relancez la restauration avec le même fichier.",
  ],

  // --- Révoquer ----------------------------------------------------------------------------------
  [E.dernierEmplacement]: [
    K.autre,
    "Il ne reste qu'un seul moyen d'ouvrir ce coffre : il n'y a rien d'autre à retirer.",
  ],
  [E.emplacementInconnu]: [
    K.recommencer,
    "Ce moyen n'ouvre déjà plus ce coffre : rien n'a été retiré. Rechargez la page.",
  ],
});

/** La table des conduites : pour chaque code du chemin, ce qu'une personne lit. */
export const CONDUITES_DU_PARCOURS = Object.freeze(
  Object.fromEntries(Object.entries(TABLE).map(([code, [, conduite]]) => [code, conduite])),
);

/** Le CLASSEMENT de chaque conduite : une valeur de `CLASSES_DE_CONDUITE`. */
export const CLASSEMENT_DES_CONDUITES = Object.freeze(
  Object.fromEntries(Object.entries(TABLE).map(([code, [classe]]) => [code, classe])),
);

/**
 * Les refus que la coquille écrit SANS code (revue de la PR #213, constat 5) : reconnus au début du
 * texte qu'elle écrit, et traduits. `source` est recopié des modules qui l'écrivent ; l'épreuve relit
 * qu'il y est toujours.
 */
export const REFUS_SANS_CODE = Object.freeze({
  versionMalTapee: Object.freeze({
    source: "La version notée sur la feuille est un nombre entier, à partir de 1.",
    classe: K.recopier,
    conduite:
      "Le numéro de version se tape en chiffres, à partir de 1, tel qu'il est noté sur votre " +
      "feuille. Si vous n'en avez pas noté, laissez ce champ vide.",
  }),
  archiveNonChoisie: Object.freeze({
    source: "Choisissez d'abord le fichier de sauvegarde à restaurer.",
    classe: K.recopier,
    conduite:
      "Aucun fichier n'est choisi. Cliquez sur « Fichier de sauvegarde », choisissez le fichier " +
      "enregistré par « Sauvegarder mon coffre », puis recommencez.",
  }),
});

/** Tous les codes du chemin, sans doublon, triés. */
export const TOUS_LES_CODES_DU_CHEMIN = Object.freeze(
  [...new Set(Object.values(CODES_DU_CHEMIN).flat())].sort(),
);

/**
 * Ce qu'une personne lit d'un refus. Un code inconnu n'est pas inventé : la phrase générique renvoie
 * au détail technique, qui porte le code.
 *
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function conduiteHumaine(code) {
  const conduite = typeof code === "string" ? CONDUITES_DU_PARCOURS[code] : undefined;
  if (conduite !== undefined) return conduite;
  return CONDUITE_GENERIQUE;
}

/**
 * Ce qu'une personne lit d'un refus écrit SANS code. Jamais le texte technique lui-même : il reste
 * sous « détails techniques ».
 *
 * @param {string | null | undefined} texte
 * @returns {string}
 */
export function conduiteDUnRefusSansCode(texte) {
  return conduiteDUnRefusSansCodeConnu(texte) ?? CONDUITE_GENERIQUE;
}

/**
 * La conduite d'un refus sans code que la table RECONNAÎT, ou `null`.
 *
 * @param {string | null | undefined} texte
 * @returns {string | null}
 */
export function conduiteDUnRefusSansCodeConnu(texte) {
  const brut = String(texte ?? "").trim();
  const connu = Object.values(REFUS_SANS_CODE).find(({ source }) => brut.startsWith(source));
  return connu === undefined ? null : connu.conduite;
}
