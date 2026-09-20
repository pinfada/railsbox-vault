// Ce que l'ACCUEIL dit d'une mise à jour de l'application (recette QA de la PR #249, Q1 à Q3, Q7, Q8).
//
// `geste-de-mise-a-jour.mjs` branche le bloc ; `parcours-de-la-page.mjs` écrit l'écran. Ce module leur
// donne ce qu'ils affichent, à partir du RELEVÉ de la coquille seulement — la décision de déphasage
// publiée par le Worker, la réponse du dernier démarrage, la phase du dernier battement. Il ne décide
// rien : le Worker redécide à chaque démarrage. Pur, comme le reste du répertoire : ni DOM, ni horloge.

import { ISSUES_DU_DEPHASAGE } from "./dephasage.mjs";
import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";
import {
  ATTENTE_DE_LA_MISE_A_JOUR,
  ATTENTE_DE_LA_REPRISE,
  MESSAGES,
} from "./textes-du-parcours.mjs";

/** Les chemins d'un démarrage, chacun avec SA durée annoncée (Q2). */
export const CHEMINS_DU_DEMARRAGE = Object.freeze({
  ordinaire: "ordinaire",
  miseAJour: "mise-a-jour",
  plusTard: "plus-tard",
});

const proposee = (dephasage) => dephasage?.issue === ISSUES_DU_DEPHASAGE.miseAJour;

/** Vrai quand seule la REPRISE d'une mise à jour commencée est possible (Q1). */
export function repriseSeule(dephasage) {
  return proposee(dephasage) && dephasage.reprise === true;
}

/**
 * Le CHEMIN du démarrage en cours : le geste « Mettre à jour » (ou « Reprendre »), « Plus tard » —
 * un démarrage sans le geste alors qu'une mise à jour est proposée —, ou le démarrage ordinaire.
 *
 * @param {{ dephasage?: object | null, miseAJourDemandee?: boolean }} rapport
 */
export function cheminDuDemarrage(rapport) {
  if (!proposee(rapport?.dephasage)) return CHEMINS_DU_DEMARRAGE.ordinaire;
  if (rapport.miseAJourDemandee === true) return CHEMINS_DU_DEMARRAGE.miseAJour;
  return rapport.dephasage.plusTard === true
    ? CHEMINS_DU_DEMARRAGE.plusTard
    : CHEMINS_DU_DEMARRAGE.ordinaire;
}

/** Le texte de chaque PHASE du démarrage (`src/vm/phase-du-boot.mjs`). */
const TEXTES_DES_PHASES = Object.freeze({
  telechargement: MESSAGES.phaseTelechargement,
  demarrage: MESSAGES.phaseDemarrage,
  donnees: MESSAGES.phaseDonnees,
});

/** Le texte de la PHASE portée par le dernier battement, ou rien pour une phase inconnue. */
export function texteDeLaPhase(phase) {
  return Object.hasOwn(TEXTES_DES_PHASES, phase ?? "") ? TEXTES_DES_PHASES[phase] : "";
}

/**
 * La ligne de PROGRESSION d'une mise à jour ou de « Plus tard », ou `null` pour un démarrage
 * ordinaire — la page garde alors la sienne.
 *
 * @param {{ chemin: string, secondes: number, phase: string | null }} observation
 */
export function progressionDuChemin({ chemin, secondes, phase }) {
  const etape = texteDeLaPhase(phase);
  if (chemin === CHEMINS_DU_DEMARRAGE.miseAJour) {
    return MESSAGES.miseAJourEnCoursDepuis(secondes, etape).trim();
  }
  if (chemin === CHEMINS_DU_DEMARRAGE.plusTard) {
    return MESSAGES.plusTardEnCoursDepuis(secondes, etape).trim();
  }
  return null;
}

/** La « Durée » de l'écran quand une mise à jour est proposée ou à reprendre ; sinon `null`. */
export function attenteDuDephasage(dephasage) {
  if (!proposee(dephasage)) return null;
  return repriseSeule(dephasage) ? ATTENTE_DE_LA_REPRISE : ATTENTE_DE_LA_MISE_A_JOUR;
}

/**
 * La VERSION de l'application, affichée en permanence (Q3) : celle qui tourne après un démarrage
 * réussi, sinon celle du coffre, sinon celle que l'origine installera. Vide si rien ne la dit.
 *
 * @param {{ application?: object | null, dephasage?: object | null }} rapport
 */
export function versionAffichee(rapport) {
  const publiee = rapport?.application?.demarree === true ? rapport.application.miseAJour : null;
  const version =
    (publiee?.geste === true ? publiee.versionServie : publiee?.versionDuCoffre) ??
    publiee?.versionServie ??
    rapport?.dephasage?.coffre?.version ??
    rapport?.dephasage?.servie?.version ??
    null;
  return typeof version === "string" && version !== ""
    ? MESSAGES.versionDeLApplication(version)
    : "";
}

/** Le code du REFUS de déphasage qui tient encore (Q7), ou `null`. */
export function refusQuiTient(rapport) {
  const dephasage = rapport?.dephasage;
  return dephasage?.issue === ISSUES_DU_DEPHASAGE.refus ? (dephasage.code ?? null) : null;
}

/**
 * Le dernier démarrage a-t-il reconnu une INSTALLATION INACHEVÉE (#250) ? La signature que le Worker
 * a mesurée, jamais une déduction du code seul.
 *
 * @param {{ application?: object | null }} rapport
 */
export function installationInachevee(rapport) {
  const application = rapport?.application;
  return application?.demarree === false && application.installationInterrompue === true;
}

/**
 * Le code dont la page dit la CONDUITE après un démarrage — ou une reprise — refusé (#250) : une
 * installation reconnue a la sienne, quel que soit le code qui la porte ; sinon le code de la réponse,
 * puis celui de la ligne d'état ; « aucune application » seulement quand rien d'autre n'est dit.
 *
 * @param {object | null | undefined} application la réponse publiée du dernier démarrage
 * @param {string | null} [codeDeLaLigne]
 */
export function codeDuDemarrageRefuse(application, codeDeLaLigne = null) {
  if (application?.installationInterrompue === true) return C.installationInachevee;
  return application?.code ?? codeDeLaLigne ?? C.applicationAbsente;
}

/** Les codes d'un démarrage refusé qui laissent le coffre SANS données d'application (#250). */
const REFUS_SANS_DONNEES_A_SAUVEGARDER = Object.freeze([
  C.installationInachevee,
  C.volumeApplicatifSansManifeste,
]);

/**
 * Les codes d'un démarrage refusé qui laissent le coffre AVEC ses données, intactes et sauvegardables
 * (#255) : l'application n'a pas été servie, le volume n'a été ni ouvert ni modifié.
 */
const REFUS_AVEC_DONNEES_A_SAUVEGARDER = Object.freeze([C.artefactDuDemarrageRefuse]);

/** Les BLOCS que l'étape 4 ajoute sous un refus, pour mettre le coffre à l'abri là où l'on est. */
export const BLOCS_D_ABRI = Object.freeze({ verrouiller: "verrouiller", sauvegarde: "sauvegarde" });

/**
 * Les gestes de mise à l'abri OFFERTS à l'étape 4 sous un refus (#252 ; #250) — ceux que la conduite
 * nomme, et eux seuls : aucun texte ne nomme un bouton absent, aucun bouton n'est offert pour échouer.
 *
 *  - un refus de déphasage qui TIENT : « Sauvegarder mon coffre » et « Verrouiller mon coffre » — ses
 *    données sont intactes, et la sauvegarde se fait sans démarrer ;
 *  - une installation inachevée, ou un volume anonyme : « Verrouiller mon coffre » seul — aucun
 *    manifeste, donc rien que la sauvegarde puisse emporter (`VAULT_COQUILLE_APPLICATION_NON_INSTALLEE`).
 *
 * @param {{ application?: object | null, dephasage?: object | null }} rapport
 * @returns {string[]} des valeurs de `BLOCS_D_ABRI`
 */
export function gestesDAbri(rapport) {
  if (refusQuiTient(rapport) !== null) return [BLOCS_D_ABRI.verrouiller, BLOCS_D_ABRI.sauvegarde];
  const application = rapport?.application;
  if (application?.demarree !== false) return [];
  const code = codeDuDemarrageRefuse(application);
  if (REFUS_AVEC_DONNEES_A_SAUVEGARDER.includes(code)) {
    return [BLOCS_D_ABRI.verrouiller, BLOCS_D_ABRI.sauvegarde];
  }
  return REFUS_SANS_DONNEES_A_SAUVEGARDER.includes(code) ? [BLOCS_D_ABRI.verrouiller] : [];
}

/**
 * « Démarrer l'application » est-il un geste POSSIBLE ? Ni sous un refus, ni sous la reprise seule, ni
 * sous une installation inachevée — c'est « Reprendre l'installation » qui la termine (#250).
 */
export function demarrerEstPossible(rapport) {
  return (
    refusQuiTient(rapport) === null &&
    !repriseSeule(rapport?.dephasage) &&
    !installationInachevee(rapport)
  );
}

/**
 * « Ce que vous avez à faire » quand le déphasage change le geste attendu (Q7), ou `null`.
 *
 * @param {{ dephasage?: object | null }} rapport
 */
export function attenduSousLeDephasage(rapport) {
  if (refusQuiTient(rapport) !== null) return MESSAGES.attenduSousUnRefus;
  if (repriseSeule(rapport?.dephasage)) return MESSAGES.attenduDeLaReprise;
  if (installationInachevee(rapport)) return MESSAGES.attenduDeLInstallationInachevee;
  return null;
}

/**
 * Le texte d'une sauvegarde prête : « pensez à redémarrer » seulement si l'application TOURNAIT (Q7).
 *
 * @param {boolean} etaitDemarree
 */
export function texteDeSauvegardePrete(etaitDemarree) {
  return MESSAGES.sauvegardePrete + (etaitDemarree ? MESSAGES.redemarrerApresSauvegarde : "");
}

/**
 * Ce que la ligne de RÉUSSITE dit d'un démarrage abouti : la mise à jour faite et sa version, quand
 * c'est elle qui vient d'aboutir (Q3) — cette ligne reste visible application démarrée, le bloc non.
 *
 * @param {{ application?: object | null }} rapport
 */
export function texteDeDemarrage(rapport) {
  const publiee = rapport?.application?.demarree === true ? rapport.application.miseAJour : null;
  return publiee?.geste === true && typeof publiee.versionServie === "string"
    ? MESSAGES.miseAJourFaite(publiee.versionServie)
    : MESSAGES.applicationDemarree;
}

/**
 * Ce que la zone de l'application dit tant qu'elle attend : elle nomme le bouton qui la démarrera
 * vraiment, ou — sous un refus — aucun (contre-recette QA de la PR #249, 2).
 *
 * @param {{ dephasage?: object | null }} rapport
 */
export function texteDeLEspaceEnAttente(rapport) {
  if (refusQuiTient(rapport) !== null) return MESSAGES.applicationEnAttenteSousUnRefus;
  if (repriseSeule(rapport?.dephasage)) return MESSAGES.applicationEnAttenteDeLaReprise;
  if (installationInachevee(rapport)) return MESSAGES.applicationEnAttenteDeLInstallation;
  return MESSAGES.applicationEnAttente;
}
