// Le BANDEAU de la copie hors connexion (#299, ADR 0048 §§ 8, 10 et 11) : ce que la personne lit de la
// réserve, et le geste « Retirer la copie hors connexion ».
//
// Il est monté par JavaScript, sans toucher à `public/index.html` : la coquille du dépôt vivant (sans
// réserve) n'en porte aucun. La région est `role="alert"` : une révocation connue APRÈS l'ouverture de la
// session est ANNONCÉE de façon visible, sans interrompre la session.
//
// Le texte d'un état dit ce qui a été OBSERVÉ, jamais plus (`reserve-fraicheur.mjs`).

import { messageDeRefus } from "./refus-de-coquille.mjs";

export const TEXTE_DU_GESTE_DE_RETRAIT = "Retirer la copie hors connexion";
export const TEXTE_PREPARATION = "Préparation hors connexion, une seule fois…";

/**
 * @param {{ document: any, surRetrait: () => void }} o
 */
export function monterLeBandeau({ document, surRetrait }) {
  const section = document.createElement("section");
  section.id = "reserve-bandeau";
  section.setAttribute("aria-label", "Copie hors connexion");
  const etat = document.createElement("p");
  etat.id = "reserve-etat";
  etat.setAttribute("role", "alert");
  const refus = document.createElement("p");
  refus.id = "reserve-refus";
  refus.setAttribute("role", "alert");
  const retirer = document.createElement("button");
  retirer.id = "retirer-la-copie";
  retirer.type = "button";
  retirer.textContent = TEXTE_DU_GESTE_DE_RETRAIT;
  retirer.addEventListener("click", () => surRetrait());
  section.append(etat, refus, retirer);
  document.body.prepend(section);
  return {
    /** @param {{ id: string, texte: string }} nouvelEtat */
    afficher(nouvelEtat) {
      etat.textContent = nouvelEtat.texte;
      etat.dataset.etat = nouvelEtat.id;
    },
    afficherLaPreparation() {
      etat.textContent = TEXTE_PREPARATION;
      etat.dataset.etat = "preparation";
    },
    /** Le refus du portail, en langage humain ; la cause reste au relevé, jamais à l'écran. */
    afficherLeRefus(code) {
      refus.textContent = messageDeRefus(code);
      refus.dataset.code = code;
    },
  };
}
