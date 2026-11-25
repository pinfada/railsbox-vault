// La RÉSERVE de la page : le branchement du portail, de l'observateur et du bandeau (#299, ADR 0048 § 7).
// Ce module NE DÉCIDE rien : `src/coquille/reserve-*.mjs` reste seul maître. Il relie le `navigator`, le
// document et le Worker de confiance à ces modules.
//
// ## Ce que la page fait
//
// 1. Le dépôt vivant (`reserve-publiee.mjs` à `null`) ne porte aucune réserve : le Worker de confiance est créé
//    comme avant, aucun Service Worker n'est enregistré.
// 2. Dans l'arbre PUBLIÉ, le Worker de confiance n'est créé que par le PORTAIL, une fois par ouverture de la
//    coquille ET à chaque réouverture après verrouillage (`creerLeCanal` repasse par lui).
// 3. Un refus ne crée ni Worker ni clé : la page le dit en langage humain et s'arrête là.

import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";
import { monterLeBandeau } from "/src/coquille/reserve-bandeau.mjs";
import { creerLaReserveDeLaPage } from "/src/coquille/reserve-portail.mjs";
import { retirerLaCopie } from "/src/coquille/reserve-retrait.mjs";
import { RESERVE_PUBLIEE } from "./reserve-publiee.mjs";

/** La poignée de main : la séquence que le Worker annonce (`reserve-annonce-du-worker.mjs`), ou son silence. */
function annonceDuTravailleur(canal, delaiMs) {
  return new Promise((resoudre) => {
    const minuterie = setTimeout(() => resoudre({ erreur: "delai" }), delaiMs);
    canal.worker.addEventListener("message", (evenement) => {
      const donnees = evenement.data;
      if (donnees?.type !== "reserve-sequence") return;
      clearTimeout(minuterie);
      resoudre({ sequence: donnees.sequence });
    });
    canal.worker.addEventListener("error", () => {
      clearTimeout(minuterie);
      resoudre({ erreur: "chargement" });
    });
  });
}

/**
 * @param {object} o
 * @param {object} o.rapport le relevé public de la coquille
 * @param {() => void} o.publier
 * @param {(etat: string, texte: string) => void} o.terminer
 * @param {() => any} o.creerLeCanal crée le Worker de confiance et son canal (SYNCHRONE)
 */
/**
 * La réserve de CETTE page, ou `null` : le point d'entrée de tout NOUVEAU portail de la même page (un
 * coffre verrouillé puis rouvert sans rechargement, ou une épreuve qui rejoue « la nouvelle ouverture »).
 * C'est la MÊME instance que celle de `main.mjs` — donc le même état de révocation et la même anomalie de
 * contrôleur — et non une copie : un module de même origine peut déjà tout ce que ce lecteur permet.
 */
let courante = null;
export const reserveCourante = () => courante;

export function creerLaReserve({ rapport, publier, terminer, creerLeCanal }) {
  if (RESERVE_PUBLIEE === null) {
    // Dépôt vivant : aucune réserve, aucun Service Worker.
    courante = { ouvrir: async () => creerLeCanal() };
    return courante;
  }
  const bandeau = monterLeBandeau({
    document,
    surRetrait: async () => {
      await retirerLaCopie({ conteneur: navigator.serviceWorker, caches });
      location.reload();
    },
  });
  rapport.reserve = {
    sequence: RESERVE_PUBLIEE.sequence,
    fraicheur: undefined,
    refus: null,
    revocation: null,
  };
  const reserve = creerLaReserveDeLaPage({
    navigateur: navigator,
    sequencePage: RESERVE_PUBLIEE.sequence,
    surEtat: (etat) => {
      rapport.reserve.fraicheur = etat.id;
      rapport.reserve.revocation = reserve.revocation.cause();
      bandeau.afficher(etat);
      publier();
    },
  });
  // Un `controllerchange` pendant la session est une ANOMALIE (ADR 0048 § 6) : plus aucun Worker n'est créé
  // (l'état partagé le retient), et la page le dit. La session ouverte n'est pas interrompue.
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    rapport.reserve.refus = {
      code: CODES_REFUS_COQUILLE.reserveDivergente,
      cause: "controleur-change",
    };
    bandeau.afficherLeRefus(CODES_REFUS_COQUILLE.reserveDivergente);
    publier();
  });
  courante = {
    /** Rend le canal de confiance, ou `null` si le portail a refusé (la page l'a dit). */
    async ouvrir() {
      const issue = await reserve.ouvrirLePortail({
        creerLeTravailleur: creerLeCanal,
        annonceDuTravailleur,
        terminerLeTravailleur: (canal) => canal.terminerLeWorker(),
      });
      if (issue.recharger === true) {
        bandeau.afficherLaPreparation();
        terminer("preparation-hors-connexion", "coquille:preparation-hors-connexion");
        location.reload();
        return null;
      }
      if (issue.autorise) return issue.travailleur;
      rapport.reserve.refus = { code: issue.code, cause: issue.cause };
      bandeau.afficherLeRefus(issue.code);
      terminer("reserve-refusee", `coquille:reserve-refusee:${issue.code}:${issue.cause}`);
      return null;
    },
  };
  return courante;
}
