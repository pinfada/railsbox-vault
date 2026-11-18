// Le RENDEUR UNIQUE de la vue de la révocation (#265, ADR 0049 § C2, protocole X1.2).
//
// ÉCHAFAUDAGE du commit rouge : le contrat est posé, le comportement ne l'est pas encore.

/** Le délai au-delà duquel une tentative qui ne se règle pas est abandonnée. */
export const DELAI_DU_RENDEUR_MS = 2000;

export function creerLeRendeur() {
  return Object.freeze({
    reveiller: () => {},
    diagnostic: () => ({ enVol: false, derniereOccurrenceTraitee: null, occurrencePubliee: null }),
  });
}
