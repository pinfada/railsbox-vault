// Les deux GESTES de l'utilisateur qui font avancer le cycle assemblé (#163, ADR 0030).
//
// Démarrer l'application (étape 3) et fermer le coffre (étape 7). Ce sont des BOUTONS, comme les
// quatre de #162, et c'est une décision : ce que la coquille fait du volume appartient à qui
// l'ouvre. Un démarrage automatique déciderait à sa place de payer deux minutes de boot, et une
// fermeture automatique déciderait d'un délai — or le délai et le déclencheur sont à #25.
//
// Ce module ne contient AUCUNE garde d'ordre. Le refus d'un boot demandé avant l'ouverture du
// backend vient du Worker de confiance (`VAULT_COQUILLE_ETAPE_HORS_ORDRE`) : la garde vit du côté
// qui tient le volume, et non du côté qui grise un bouton. Un bouton grisé n'apprend rien à qui
// l'atteint autrement, et l'épreuve n'a rien à mesurer — c'est déjà l'argument de l'ADR 0028 sur
// `VAULT_COQUILLE_VOLUME_VERROUILLE`.

import { ISSUES_DETAPE } from "./cycle-de-vie.mjs";

/**
 * Branche les deux gestes et rend de quoi les déclencher sans passer par le document — ce dont une
 * épreuve a besoin, et ce qu'aucun chemin de produit n'emploie.
 *
 * @param {{ racine: Document, demander: (type: string, corps?: object) => Promise<any>,
 *           cycle: { issueDe: (etape: string) => string | null, releve: () => object[],
 *                    conclure: (etape: string, issue: string, motif?: string | null) => void },
 *           rapport: Record<string, unknown>, publier: () => void,
 *           apresFermeture: () => void }} liaison
 */
export function brancherLesGestesDuCycle(liaison) {
  const contexte = { ...liaison, dire: ecrivainDEtat(liaison.racine) };
  const demarrerLApplication = () => demarrer(contexte);
  const fermerLeCoffre = () => fermer(contexte);
  liaison.racine.querySelector("#demarrer-application")?.addEventListener("click", () => {
    void demarrerLApplication();
  });
  liaison.racine.querySelector("#fermer-le-coffre")?.addEventListener("click", () => {
    void fermerLeCoffre();
  });
  return Object.freeze({ demarrerLApplication, fermerLeCoffre });
}

/** Écrit la ligne d'état du cycle. La seule façon dont ces deux gestes touchent le document. */
function ecrivainDEtat(racine) {
  return (texte) => {
    const noeud = racine.querySelector("#cycle-etat");
    if (noeud !== null) noeud.textContent = texte;
  };
}

/**
 * Conclut une étape, et ne fait rien si elle l'est déjà. Un second geste de fermeture ne doit pas
 * faire échouer une fermeture qui, elle, s'est bien passée : le journal refuse une étape conclue
 * deux fois, et c'est ici la bonne réponse à ce refus.
 */
function conclureSiPossible({ cycle, rapport }, etape, issue, motif = null) {
  if (cycle.issueDe(etape) !== null) return;
  cycle.conclure(etape, issue, motif);
  rapport.cycle = cycle.releve();
}

/** ÉTAPE 3 — le geste qui démarre l'application : installation si besoin, backend, puis VM. */
async function demarrer({ demander, rapport, publier, dire }) {
  dire("cycle:demarrage-en-cours");
  try {
    const rendu = await demander("application", {});
    rapport.application = rendu;
    if (rendu.barrieres !== undefined) rapport.barrieres = rendu.barrieres;
    if (rendu.etat !== undefined) rapport.etat = rendu.etat;
    publier();
    dire(rendu.demarree ? "cycle:application-demarree" : `cycle:sans-application:${rendu.motif}`);
    return rendu;
  } catch (erreur) {
    // Un refus est PUBLIÉ, jamais avalé : c'est par lui que l'épreuve de l'ordre lit « boot demandé
    // avant l'ouverture du backend », et par lui que l'utilisateur apprend pourquoi.
    rapport.application = { demarree: false, code: erreur?.code ?? null };
    publier();
    dire(`cycle:demarrage-refuse:${erreur?.code ?? "inconnu"}`);
    return rapport.application;
  }
}

/**
 * ÉTAPE 7 — la fermeture propre. Le Worker arrête la VM, capture, ferme les volumes ; PUIS la page
 * termine le Worker (`apresFermeture`). L'ordre est le contrat : terminer avant `close()` laisserait
 * le handle exclusif tenu par un objet que plus personne ne référence, et l'ouverture suivante
 * rendrait `VAULT_STORAGE_BUSY`.
 */
async function fermer(contexte) {
  const { demander, rapport, publier, dire, apresFermeture } = contexte;
  dire("cycle:fermeture-en-cours");
  try {
    const rendu = await demander("fermeture", {});
    rapport.etat = rendu.etat;
    rapport.barrieres = rendu.barrieres;
    rapport.fermeture = { capture: rendu.capture ?? null };
    // Les étapes 5 et 6 sont conclues ICI, et pas plus tôt : l'étape 5 est ce que le guest a écrit
    // pendant la session, et le compte de barrières n'est arrêté qu'à la fermeture ; l'étape 6 reste
    // un BANC, et le journal le dit plutôt que de la passer sous silence.
    conclureSiPossible(contexte, "ecritureEtBarriere", ISSUES_DETAPE.franchie);
    conclureSiPossible(contexte, "exportEtMigration", ISSUES_DETAPE.banc, "public/vm/ — export");
    conclureSiPossible(contexte, "fermeture", ISSUES_DETAPE.franchie);
    publier();
  } catch (erreur) {
    dire(`cycle:fermeture-refusee:${erreur?.code ?? "inconnu"}`);
    return { fermee: false, code: erreur?.code ?? null };
  }
  apresFermeture();
  dire("cycle:coffre-ferme");
  return { fermee: true };
}
