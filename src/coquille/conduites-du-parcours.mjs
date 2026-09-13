// Les CONDUITES du parcours guidé (#193, ADR 0040) : ce qu'une personne lit quand un geste est refusé.
//
// Les conduites de `interface-de-deverrouillage.mjs` et les messages de `refus-de-coquille.mjs`
// parlent à un exploitant : ils nomment l'enveloppe, le plancher de rejeu, le Worker de confiance. Ils
// RESTENT — sous « détails techniques », et dans les épreuves qui les lisent. Ce module ajoute une
// seconde table, écrite pour quelqu'un qui ne connaît ni le vocabulaire du dépôt ni la cryptographie :
// ce qui s'est passé, si quelque chose a été perdu, et ce qu'il peut faire maintenant.
//
// ## Le cliquet
//
// `CODES_DU_CHEMIN` nomme, par geste du parcours, les codes que ce geste peut rendre. L'épreuve
// `tests/unit/coquille-parcours-conduites.test.mjs` exige que CHAQUE code du chemin ait une conduite
// ici, que chaque conduite se lise sans vocabulaire interne, et que chaque code de la coquille, de
// l'archive et de la restauration soit soit dans le chemin, soit écarté NOMMÉMENT avec son motif
// (`CODES_HORS_DU_CHEMIN`). Un code neuf qui n'entre dans aucune des deux listes fait rougir l'épreuve
// — c'est la forme du cliquet du § 10.
//
// ## Ce que ce module ne décide pas
//
// Aucun refus. Il ne change ni un code, ni une garde, ni l'ordre d'un geste : il traduit.

import { ARCHIVE_ERROR_CODES } from "../vm/archive-errors.mjs";
import { DERIVATION_ERROR_CODES } from "../vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../vm/enveloppe/enveloppe-errors.mjs";
import { IMPORT_ERROR_CODES } from "../vm/import-errors.mjs";
import { STORAGE_ERROR_CODES } from "../vm/storage-errors.mjs";
import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

const RIEN_PERDU = "Rien n'a été perdu.";
const REESSAYER_PLUS_TARD =
  "Rechargez la page puis réessayez. Si cela se reproduit, notez le détail technique ci-dessous " +
  "et demandez de l'aide.";

/**
 * Les codes que chaque geste du parcours peut rendre, groupés par geste. Un code peut appartenir à
 * plusieurs gestes : la liste dit où on le rencontre, la table dit ce qu'on en lit.
 */
export const CODES_DU_CHEMIN = Object.freeze({
  deverrouillage: Object.freeze([
    ENVELOPPE_ERROR_CODES.cleRefusee,
    ENVELOPPE_ERROR_CODES.rejeu,
    ENVELOPPE_ERROR_CODES.absente,
    ENVELOPPE_ERROR_CODES.illisible,
    ENVELOPPE_ERROR_CODES.identite,
    ENVELOPPE_ERROR_CODES.troncature,
    ENVELOPPE_ERROR_CODES.melange,
    ENVELOPPE_ERROR_CODES.malforme,
    ENVELOPPE_ERROR_CODES.racineRefusee,
    DERIVATION_ERROR_CODES.typeInconnu,
    DERIVATION_ERROR_CODES.parametresRefuses,
    DERIVATION_ERROR_CODES.phraseRefusee,
    DERIVATION_ERROR_CODES.prfIndisponible,
    DERIVATION_ERROR_CODES.prfIgnoree,
    DERIVATION_ERROR_CODES.annulee,
    DERIVATION_ERROR_CODES.codeMalRecopie,
    DERIVATION_ERROR_CODES.codeDejaRendu,
    DERIVATION_ERROR_CODES.argon2Indisponible,
    STORAGE_ERROR_CODES.unsupported,
    STORAGE_ERROR_CODES.busy,
    STORAGE_ERROR_CODES.quotaExceeded,
    STORAGE_ERROR_CODES.volumeSansRacine,
    STORAGE_ERROR_CODES.engagementInvalide,
    STORAGE_ERROR_CODES.creationNonConfirmee,
    STORAGE_ERROR_CODES.identiteVolume,
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
    STORAGE_ERROR_CODES.busy,
    STORAGE_ERROR_CODES.quotaExceeded,
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
    STORAGE_ERROR_CODES.creationNonConfirmee,
    C.gesteRompu,
  ]),
  verrouillage: Object.freeze([
    C.etapeHorsOrdre,
    STORAGE_ERROR_CODES.flushFailed,
    STORAGE_ERROR_CODES.handleLost,
    C.workerMort,
    C.gesteRompu,
  ]),
  sauvegarde: Object.freeze([
    C.volumeVerrouille,
    C.applicationNonInstallee,
    C.gesteEnCours,
    C.disqueDUnAutreCoffre,
    STORAGE_ERROR_CODES.quotaExceeded,
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
    ARCHIVE_ERROR_CODES.malformed,
    ARCHIVE_ERROR_CODES.truncated,
    ARCHIVE_ERROR_CODES.digestMismatch,
    ARCHIVE_ERROR_CODES.geometryMismatch,
    ARCHIVE_ERROR_CODES.recuperationAlteree,
    ARCHIVE_ERROR_CODES.recuperationRefusee,
    ARCHIVE_ERROR_CODES.versionNonLue,
    ARCHIVE_ERROR_CODES.engagementAbsent,
    IMPORT_ERROR_CODES.targetNotEmpty,
    IMPORT_ERROR_CODES.spaceInsufficient,
    IMPORT_ERROR_CODES.geometryMismatch,
    IMPORT_ERROR_CODES.verificationFailed,
    STORAGE_ERROR_CODES.quotaExceeded,
    C.workerMort,
    C.gesteRompu,
  ]),
  revocation: Object.freeze([
    C.volumeVerrouille,
    C.gesteEnCours,
    ENVELOPPE_ERROR_CODES.dernierEmplacement,
    C.workerMort,
    C.gesteRompu,
  ]),
});

/**
 * Les codes de la coquille, de l'archive et de la restauration qui NE SONT PAS sur le chemin, chacun
 * avec son motif. Une exclusion est une décision écrite, jamais un oubli.
 */
export const CODES_HORS_DU_CHEMIN = Object.freeze({
  [C.contratRefuse]: "port restreint : un document applicatif d'un autre dialecte",
  [C.typeInconnu]: "port restreint et canal global : un message hors contrat, jamais un geste",
  [C.kek]: "port restreint : l'application demande une clé",
  [C.dek]: "port restreint : l'application demande une clé",
  [C.exportation]: "port restreint : l'application demande l'export",
  [C.revocation]: "port restreint : l'application demande une révocation",
  [C.emplacement]: "port restreint : l'application ajoute un moyen",
  [C.recuperation]: "port restreint : l'application crée un moyen de récupération",
  [C.volume]: "port restreint : l'application choisit un volume",
  [C.enveloppe]: "port restreint : l'application lit l'enveloppe",
  [C.portPrivilegie]: "port restreint : l'application vise le canal privilégié",
  [C.handle]: "port restreint : l'application demande un handle",
  [C.canalAbsent]: "annonce du cadre : ordre interne, jamais un geste de l'utilisateur",
  [C.annonceType]: "annonce du cadre",
  [C.annonceOrigine]: "annonce du cadre",
  [C.annonceFenetre]: "annonce du cadre",
  [C.annonceUnique]: "annonce du cadre",
  [C.correlationAbsente]: "contrat de messages : défaut de programmation, compté au relevé",
  [C.correlationDupliquee]: "contrat de messages : défaut de programmation, compté au relevé",
  [C.tropDeRequetes]: "port restreint : l'application inonde la coquille",
  [C.capaciteDansUnMessage]: "contrat de messages : une capacité refusée avant l'envoi",
  [C.canalDeRelaisRefuse]: "port restreint : l'application vise le canal de relais",
  [IMPORT_ERROR_CODES.consentementRequis]:
    "restauration antérieure à la feuille (ADR 0027) : la coquille ne l'offre pas",
});

/** La table des conduites, écrite pour une personne. Une phrase par code, parfois trois. */
export const CONDUITES_DU_PARCOURS = Object.freeze({
  // --- Ouvrir ------------------------------------------------------------------------------------
  [ENVELOPPE_ERROR_CODES.cleRefusee]:
    "Ce que vous avez présenté n'ouvre pas ce coffre : la phrase est peut-être mal tapée (majuscules, " +
    "accents, espaces), ou ce n'est pas le bon code. " +
    RIEN_PERDU +
    " Réessayez tranquillement : il n'y a pas de nombre d'essais limité.",
  [ENVELOPPE_ERROR_CODES.rejeu]:
    "Le numéro de version que vous avez tapé est plus grand que celui de ce coffre. Relisez le " +
    "numéro sur votre feuille. Si vous n'êtes pas sûr, videz ce champ et réessayez : le coffre " +
    "s'ouvrira, mais sans vérifier qu'on ne lui a pas remis une copie plus ancienne.",
  [ENVELOPPE_ERROR_CODES.absente]:
    "Il n'y a pas de coffre sur cet appareil. Si vous en avez créé un ailleurs, restaurez sa " +
    "sauvegarde ici.",
  [ENVELOPPE_ERROR_CODES.illisible]:
    "Le fichier qui protège ce coffre sur cet appareil est abîmé. N'effacez rien. Si vous avez une " +
    "sauvegarde, elle peut être restaurée sur un autre navigateur ou une autre adresse.",
  [ENVELOPPE_ERROR_CODES.identite]:
    "Le fichier qui protège ce coffre ne correspond pas à ce coffre. N'effacez rien, et restaurez " +
    "votre sauvegarde sur un emplacement vide.",
  [ENVELOPPE_ERROR_CODES.troncature]:
    "Le fichier qui protège ce coffre est incomplet sur cet appareil. N'effacez rien. Si vous avez une " +
    "sauvegarde, restaurez-la sur un emplacement vide.",
  [ENVELOPPE_ERROR_CODES.melange]:
    "Le fichier qui protège ce coffre a été assemblé à partir de deux copies différentes. N'effacez " +
    "rien, et restaurez votre sauvegarde sur un emplacement vide.",
  [ENVELOPPE_ERROR_CODES.malforme]:
    "Le fichier qui protège ce coffre n'est pas lisible. N'effacez rien, et restaurez votre " +
    "sauvegarde sur un emplacement vide.",
  [ENVELOPPE_ERROR_CODES.racineRefusee]:
    "Ce coffre ne peut pas prouver que son contenu est intact. Ne l'utilisez pas : restaurez votre " +
    "sauvegarde sur un emplacement vide.",
  [DERIVATION_ERROR_CODES.typeInconnu]:
    "Ce coffre a été fermé par une version plus récente de RailsBox Vault. Mettez l'application à " +
    "jour, puis réessayez. " +
    RIEN_PERDU,
  [DERIVATION_ERROR_CODES.parametresRefuses]:
    "Les réglages enregistrés pour ouvrir ce coffre ne sont pas acceptables : ce coffre a peut-être " +
    "été modifié. " +
    RIEN_PERDU +
    " Ouvrez-le par votre code de récupération, ou restaurez votre sauvegarde.",
  [DERIVATION_ERROR_CODES.phraseRefusee]:
    "Cette phrase ne peut pas servir : elle est vide ou trop courte. Choisissez une phrase de " +
    "plusieurs mots, facile à retenir pour vous et difficile à deviner pour les autres.",
  [DERIVATION_ERROR_CODES.prfIndisponible]:
    "Cette passkey ne sait pas protéger un coffre. Utilisez une phrase, ou une autre passkey.",
  [DERIVATION_ERROR_CODES.prfIgnoree]:
    "L'appareil a reconnu votre passkey mais n'a pas rendu ce qu'il fallait pour ouvrir le coffre. " +
    "Utilisez une phrase, ou une autre passkey.",
  [DERIVATION_ERROR_CODES.annulee]:
    "La demande a été annulée, ou personne n'y a répondu à temps. " +
    RIEN_PERDU +
    " Vous pouvez recommencer.",
  [DERIVATION_ERROR_CODES.codeMalRecopie]:
    "Le code a une faute de recopie : une lettre ou un chiffre est mal lu, ou deux sont inversés. " +
    "Relisez votre feuille, symbole par symbole. Les tirets, les espaces et les majuscules n'ont " +
    "pas d'importance.",
  [DERIVATION_ERROR_CODES.codeDejaRendu]:
    "Le code de récupération ne s'affiche qu'une fois, et il a déjà été affiché. Si vous ne l'avez " +
    "pas recopié, créez-en un nouveau.",
  [DERIVATION_ERROR_CODES.argon2Indisponible]:
    "Ce navigateur ne peut pas faire le calcul qui protège le coffre. Essayez un autre navigateur " +
    "récent (Chrome, Edge ou Firefox).",
  [STORAGE_ERROR_CODES.unsupported]:
    "Ce navigateur ne sait pas garder un coffre. Essayez un autre navigateur récent (Chrome, Edge " +
    "ou Firefox). " +
    RIEN_PERDU,
  [STORAGE_ERROR_CODES.busy]:
    "Ce coffre est déjà ouvert dans un autre onglet ou une autre fenêtre. Fermez l'autre onglet, " +
    "puis réessayez ici.",
  [STORAGE_ERROR_CODES.quotaExceeded]:
    "Il n'y a plus assez de place pour ce coffre dans ce navigateur. Libérez de l'espace sur " +
    "l'appareil, puis réessayez.",
  [STORAGE_ERROR_CODES.volumeSansRacine]:
    "La restauration de ce coffre n'est pas allée jusqu'au bout. Restaurez à nouveau la sauvegarde, " +
    "puis ouvrez le coffre tout de suite après.",
  [STORAGE_ERROR_CODES.engagementInvalide]:
    "Le contenu de ce coffre ne correspond pas à sa sauvegarde : il a été modifié. Ne l'utilisez " +
    "pas ; restaurez une sauvegarde en laquelle vous avez confiance.",
  [STORAGE_ERROR_CODES.creationNonConfirmee]:
    "L'installation n'a pas pu être vérifiée sur cet appareil. Rien n'est déclaré installé : " +
    "recommencez.",
  [STORAGE_ERROR_CODES.identiteVolume]:
    "Les données de ce coffre ne lui appartiennent pas. N'effacez rien, et restaurez votre " +
    "sauvegarde sur un emplacement vide.",
  [C.volumeVerrouille]:
    "Le coffre doit d'abord être ouvert pour faire cela. Ouvrez-le, puis recommencez.",
  [C.coffreAnterieur]:
    "Ce coffre a été créé par une version d'essai antérieure au 13 septembre 2026, que cette version " +
    "ne sait pas ouvrir. Pour repartir de zéro : dans les réglages du navigateur, effacez les données " +
    "de ce site, rechargez la page, puis créez un nouveau coffre. Ce qui était dans l'ancien coffre " +
    "sera effacé.",
  [C.disqueDUnAutreCoffre]:
    "L'application enregistrée sur cet appareil n'appartient pas à ce coffre. Rien n'a été ouvert ni " +
    "modifié. Pour repartir d'un emplacement vide, effacez les données de ce site dans les réglages " +
    "du navigateur, puis restaurez la sauvegarde de votre coffre.",
  [C.coffreServiSansManifeste]:
    "Ce coffre a été utilisé après sa restauration, puis une partie de ses informations a disparu. " +
    "Le réparer effacerait ce que vous y avez écrit depuis : rien n'a été touché. N'effacez pas les " +
    "données de ce site, gardez votre sauvegarde, et demandez de l'aide.",
  [C.restaurationInterrompue]:
    "Une restauration a été interrompue avant la fin : le coffre n'est pas prêt. Choisissez de " +
    "nouveau le même fichier de sauvegarde et relancez la restauration.",
  [C.capaciteManquante]:
    "Ce navigateur n'offre pas tout ce dont le coffre a besoin. Essayez un autre navigateur récent " +
    "(Chrome, Edge ou Firefox).",
  [C.messageMalforme]:
    "Ce qui a été saisi ou choisi n'a pas la forme attendue : le numéro de version est un nombre " +
    "entier, et une restauration demande un fichier de sauvegarde. Corrigez, puis réessayez.",
  [C.workerMort]:
    "Le coffre a cessé de répondre. Par sécurité, il ne fait plus rien tant que vous ne l'avez pas " +
    "rouvert. Ce qui a été enregistré avant reste enregistré. Cliquez sur « Rouvrir le coffre ».",
  [C.gesteRompu]: "L'opération n'a pas abouti, sans cause identifiée. " + REESSAYER_PLUS_TARD,

  // --- L'application -----------------------------------------------------------------------------
  [C.etapeHorsOrdre]:
    "Une autre opération est en cours, ou le coffre n'est pas encore ouvert. Attendez la fin de " +
    "l'opération en cours, puis recommencez.",
  [C.applicationAbsente]:
    "Aucune application n'est livrée avec ce coffre à cette adresse : il n'y a rien à démarrer.",
  [C.gesteEnCours]:
    "Une opération longue est déjà en cours (démarrage, sauvegarde ou restauration). Attendez " +
    "qu'elle se termine, puis recommencez.",
  [C.volumeApplicatifSansManifeste]:
    "Une installation précédente a été interrompue avant la fin. Rien n'a été écrasé. Si le bouton " +
    "« Reprendre l'installation » apparaît, utilisez-le.",
  [C.applicationNonDemarree]:
    "L'application n'est pas démarrée. Ouvrez le coffre, puis cliquez sur « Démarrer l'application ».",
  [C.requeteHttpRefusee]:
    "L'application a demandé quelque chose que le coffre ne transmet pas. Revenez à la page " +
    "précédente de l'application et réessayez.",
  [C.reponseHttpTropGrande]:
    "La page demandée à l'application est trop volumineuse pour être affichée ici.",
  [C.relaisAbandonne]:
    "La page n'a pas été affichée parce que le coffre venait d'être verrouillé. Rouvrez le coffre " +
    "pour continuer.",

  // --- Verrouiller -------------------------------------------------------------------------------
  [STORAGE_ERROR_CODES.flushFailed]:
    "Le coffre n'a pas pu confirmer l'enregistrement de vos dernières modifications. Par sécurité, " +
    "il est arrêté. Rouvrez-le : ce qui avait été confirmé est conservé.",
  [STORAGE_ERROR_CODES.handleLost]:
    "Le navigateur a retiré au coffre l'accès à ses données. Par sécurité, il est arrêté. Rouvrez-le.",

  // --- Sauvegarder -------------------------------------------------------------------------------
  [C.applicationNonInstallee]:
    "Il n'y a encore rien à sauvegarder : démarrez l'application une première fois.",

  // --- Restaurer ---------------------------------------------------------------------------------
  [C.emplacementOccupe]:
    "Cet appareil a déjà un coffre à cette adresse. On ne restaure jamais par-dessus un coffre " +
    "existant : restaurez à une autre adresse, dans un autre navigateur, ou sur un autre appareil.",
  [C.archiveDUnAutreCoffre]:
    "Ce fichier n'est pas une sauvegarde de coffre RailsBox Vault. Rien n'a été écrit. Choisissez le " +
    "fichier enregistré par « Sauvegarder mon coffre ».",
  [C.archiveSansRecuperation]:
    "Cette sauvegarde a été faite sans code de récupération : elle ne peut s'ouvrir nulle part " +
    "ailleurs. Rien n'a été écrit.",
  [ARCHIVE_ERROR_CODES.malformed]:
    "Ce fichier n'est pas une sauvegarde lisible. Rien n'a été écrit. Choisissez le fichier " +
    "enregistré par « Sauvegarder mon coffre ».",
  [ARCHIVE_ERROR_CODES.truncated]:
    "Ce fichier de sauvegarde est incomplet, souvent à cause d'un téléchargement ou d'une copie " +
    "interrompus. Rien n'a été écrit. Enregistrez ou copiez de nouveau la sauvegarde.",
  [ARCHIVE_ERROR_CODES.digestMismatch]:
    "Cette sauvegarde a été abîmée ou modifiée depuis qu'elle a été faite : son contenu ne " +
    "correspond plus. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.",
  [ARCHIVE_ERROR_CODES.geometryMismatch]:
    "Cette sauvegarde est incohérente. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.",
  [ARCHIVE_ERROR_CODES.recuperationAlteree]:
    "La partie de cette sauvegarde qui permet de l'ouvrir par le code a été abîmée. Rien n'a été " +
    "écrit. Utilisez une autre copie de la sauvegarde.",
  [ARCHIVE_ERROR_CODES.recuperationRefusee]:
    "Cette sauvegarde ne s'ouvre pas par un code de récupération. Rien n'a été écrit.",
  [ARCHIVE_ERROR_CODES.versionNonLue]:
    "Cette sauvegarde a été faite par une version différente de RailsBox Vault, que celle-ci ne sait " +
    "pas lire. Rien n'a été écrit.",
  [ARCHIVE_ERROR_CODES.engagementAbsent]:
    "Cette sauvegarde ne permet pas de vérifier que son contenu est intact. Rien n'a été écrit. " +
    "Utilisez une sauvegarde faite par « Sauvegarder mon coffre ».",
  [IMPORT_ERROR_CODES.targetNotEmpty]:
    "Cet appareil a déjà un coffre à cette adresse : rien n'a été écrit. Restaurez à une autre " +
    "adresse, dans un autre navigateur, ou sur un autre appareil.",
  [IMPORT_ERROR_CODES.spaceInsufficient]:
    "Il n'y a pas assez de place dans ce navigateur pour restaurer cette sauvegarde. Rien n'a été " +
    "écrit. Libérez de l'espace sur l'appareil, puis réessayez.",
  [IMPORT_ERROR_CODES.geometryMismatch]:
    "Cette sauvegarde ne correspond pas à ce que cet appareil attend. Rien n'a été écrit.",
  [IMPORT_ERROR_CODES.verificationFailed]:
    "La sauvegarde a été copiée, mais la vérification de la copie a échoué. Le coffre n'est pas " +
    "prêt : relancez la restauration avec le même fichier.",

  // --- Révoquer ----------------------------------------------------------------------------------
  [ENVELOPPE_ERROR_CODES.dernierEmplacement]:
    "Il ne reste qu'un seul moyen d'ouvrir ce coffre : il n'y a rien d'autre à retirer.",
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
  return "L'opération a été refusée. " + REESSAYER_PLUS_TARD;
}
