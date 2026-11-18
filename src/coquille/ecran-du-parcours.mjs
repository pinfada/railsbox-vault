// Quel ÉCRAN le parcours montre, d'après ce que la page a OBSERVÉ (#193, ADR 0040).
//
// Extrait de `public/coquille/parcours-de-la-page.mjs` (#265, relecture de #308) : la construction de
// l'observation — ce que le relevé, le rapport et l'état de la page transmettent à `ecranCourant` —
// est ICI, pour que Node l'éprouve et que la campagne de mutation en mute chaque transmission.

import { coffreObserve, ecranCourant } from "./parcours.mjs";

/**
 * @param {{ etat: object, releve: object, rapport: object, texteDesMoyens: string, moteur: string }} page
 * @returns {string} une clé de `ECRANS`, ou `"chargement"`
 */
export function ecranDuParcours({ etat, releve, rapport, texteDesMoyens, moteur }) {
  etat.coffre = coffreObserve({
    etat: rapport.etat,
    texteDesMoyens,
    moyensProposes: releve.moyensProposes ?? [],
    dernierRefus: releve.dernierRefus,
  });
  if (!etat.progressionLue) return "chargement";
  return ecranCourant({
    pointeur: etat.pointeur,
    coffre: etat.coffre,
    moyens: releve.moyensProposes ?? [],
    nombreDeCodes: releve.nombreDeCodes,
    // Le CONSTAT du Worker, jamais l'indice du fichier : c'est la garde des étapes 4 à 9 (#239).
    feuilleEprouvee: rapport.feuilleEprouvee === true,
    inventaire: releve.inventaire, // pas de repli : sans cause, l'inventaire est « non relu »
    progression: etat.progression,
    sousEtatDuCode: etat.sousEtatDuCode,
    revocationFaite: etat.revocationFaite,
    sansRevoquer: etat.sansRevoquer,
    phrasePerdue: etat.phrasePerdue,
    nouveauCodeDemande: etat.nouveauCodeDemande,
    refus: releve.dernierRefus ?? null,
    moteur,
  });
}
