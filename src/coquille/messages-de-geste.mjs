// Ce qu'un clic sur un bouton EFFACE : le message précédent, jamais une annonce qui doit survivre.
//
// `parcours-incertitude` (la révocation en vol ou d'issue incertaine, #265) n'y figure PAS : elle ne
// se lève que par une révocation qui aboutit ou la réouverture du coffre.

/** Les régions que le clic efface. */
export const MESSAGES_EFFACES_AU_CLIC = Object.freeze(["parcours-refus", "parcours-reussite"]);

/** @param {(id: string, texte: string) => void} dire */
export function effacerLesMessagesDeGeste(dire) {
  for (const id of MESSAGES_EFFACES_AU_CLIC) dire(id, "");
}
