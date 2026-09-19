// Le BLOC « Mettre à jour l'application », côté PAGE (#236 T2, ADR 0042 ; ADR 0040, note datée).
//
// Après le déverrouillage, la page demande au Worker de confiance ce que le coffre et l'origine disent
// l'un de l'autre (`vault.coquille.constater-le-dephasage`). Trois suites, et aucune ne boote :
//
//  - un REFUS (autre application, version non servie, données plus récentes, schéma inconnu) : la
//    conduite humaine s'affiche à l'accueil, par la même ligne d'état que tout refus du cycle ;
//  - une MISE À JOUR proposée : le bloc se montre, avec ce qui va se passer, la sauvegarde proposée
//    AVANT, et « Plus tard » quand l'origine sert encore la version du coffre ;
//  - rien à dire : le bloc reste caché, l'accueil est celui de tous les jours.
//
// Ce module ne DÉCIDE rien : le Worker redécide à chaque démarrage, et un bouton cliqué hors de
// propos est refusé là-bas, typé. Ce qu'il porte est l'ORDRE des gestes : jamais de migration sans
// le clic « Mettre à jour l'application ».

import { ISSUES_DU_DEPHASAGE } from "./dephasage.mjs";
import { MESSAGES } from "./textes-du-parcours.mjs";

/**
 * Branche le bloc et rend de quoi le piloter sans passer par le document — ce dont une épreuve a
 * besoin, et ce qu'aucun chemin de produit n'emploie.
 *
 * @param {{ racine: Document, demander: (type: string, corps?: object) => Promise<any>,
 *           rapport: Record<string, unknown>, publier: () => void,
 *           demarrer: (corps?: object) => Promise<any> }} liaison
 */
export function brancherLeGesteDeMiseAJour(liaison) {
  const { racine } = liaison;
  const noeud = (id) => racine.querySelector(`#${id}`);
  const constater = () => constaterLeDephasage(liaison, noeud);
  const mettreAJour = () => mettreAJourLApplication(liaison, noeud);
  const plusTard = () => reporter(liaison, noeud);
  noeud("mettre-a-jour-l-application")?.addEventListener("click", () => void mettreAJour());
  noeud("plus-tard")?.addEventListener("click", plusTard);
  // « Sauvegarder d'abord » EMPRUNTE le geste existant (ADR 0039) : une seule sauvegarde, un seul
  // chemin, une seule conduite — le bouton de l'accueil fait exactement la même chose.
  noeud("sauvegarder-avant-mise-a-jour")?.addEventListener("click", () => {
    noeud("sauvegarder-le-coffre")?.click();
  });
  return Object.freeze({ constater, mettreAJour, plusTard });
}

/** Écrit la ligne d'état du cycle : la conduite d'un refus passe par elle, comme les autres. */
function dire(racine, texte) {
  const ligne = racine.querySelector("#cycle-etat");
  if (ligne !== null) ligne.textContent = texte;
}

/** Montre le bloc pour une mise à jour proposée, ou le cache. */
function montrer(noeud, decision) {
  const bloc = noeud("mise-a-jour");
  if (bloc === null) return;
  if (decision === null || decision.issue !== ISSUES_DU_DEPHASAGE.miseAJour) {
    bloc.hidden = true;
    return;
  }
  noeud("mise-a-jour-texte").textContent = MESSAGES.miseAJourProposee(
    decision.coffre?.version ?? "?",
    decision.servie?.version ?? "?",
    decision.migration === true,
  );
  noeud("mise-a-jour-plus-tard-texte").textContent = decision.plusTard
    ? MESSAGES.miseAJourPlusTard
    : MESSAGES.miseAJourSansPlusTard;
  noeud("plus-tard").hidden = decision.plusTard !== true;
  for (const id of ["sauvegarder-avant-mise-a-jour", "mettre-a-jour-l-application"]) {
    noeud(id).hidden = false;
  }
  bloc.hidden = false;
}

/**
 * CONSTATE le déphasage, une fois le coffre ouvert. Un refus du Worker lui-même (l'ordre, un Worker
 * mort) n'empêche rien : l'accueil reste celui de tous les jours, et le démarrage redécidera.
 */
async function constaterLeDephasage({ racine, demander, rapport, publier }, noeud) {
  let decision;
  try {
    decision = await demander("dephasage", {});
  } catch (erreur) {
    rapport.dephasage = { issue: null, code: erreur?.code ?? null };
    publier();
    return rapport.dephasage;
  }
  rapport.dephasage = decision;
  publier();
  montrer(noeud, decision);
  if (decision.issue === ISSUES_DU_DEPHASAGE.refus) {
    dire(racine, `cycle:application-refusee:${decision.code}`);
  }
  return decision;
}

/**
 * Le GESTE : démarrer avec `miseAJour`, et dire ce qui a été fait. Le bouton se désactive pendant
 * le geste ; un second clic ne part pas.
 */
async function mettreAJourLApplication({ rapport, publier, demarrer }, noeud) {
  const bouton = noeud("mettre-a-jour-l-application");
  if (bouton?.disabled) return null;
  if (bouton) bouton.disabled = true;
  noeud("mise-a-jour-plus-tard-texte").textContent = MESSAGES.miseAJourEnCours;
  try {
    const rendu = await demarrer({ miseAJour: true });
    if (rendu?.demarree === true) {
      noeud("mise-a-jour-texte").textContent = MESSAGES.miseAJourFaite(
        rendu.miseAJour?.versionServie ?? "",
      );
      noeud("mise-a-jour-plus-tard-texte").textContent = "";
      for (const id of [
        "sauvegarder-avant-mise-a-jour",
        "mettre-a-jour-l-application",
        "plus-tard",
      ]) {
        noeud(id).hidden = true;
      }
    }
    rapport.miseAJour = rendu?.miseAJour ?? null;
    publier();
    return rendu;
  } finally {
    if (bouton) bouton.disabled = false;
  }
}

/** « Plus tard » : le bloc se referme, l'accueil reste tel qu'il est, sur la version actuelle. */
function reporter({ rapport, publier }, noeud) {
  const bloc = noeud("mise-a-jour");
  if (bloc !== null) bloc.hidden = true;
  rapport.dephasage = { ...(rapport.dephasage ?? {}), reportee: true };
  publier();
}
