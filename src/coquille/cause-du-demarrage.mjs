// Ce qu'une personne lit quand l'APPLICATION n'a pas répondu : la conduite, puis la cause (#351).
//
// Séparé de `conduites-du-parcours.mjs`, qui est une table plate sous surveillance de taille : cette
// fonction n'est pas une ligne de la table, elle la complète par ce que le guest a dit.

import { conduiteHumaine } from "./conduites-du-parcours.mjs";
import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

/** Ce qu'une cause de démarrage peut peser dans l'alerte : celle du guest est déjà bornée à 600. */
const CAUSE_AFFICHEE_MAX = 600;

// eslint-disable-next-line no-control-regex
const CARACTERES_DE_CONTROLE = /[\u0000-\u001f\u007f]/g;

/**
 * La conduite d'une application qui n'a pas répondu, SUIVIE de sa cause en clair.
 *
 * La cause vient du guest (`src/vm/sonde-de-demarrage.mjs`) : elle est écrite comme du TEXTE, sans
 * caractère de contrôle, bornée ici une seconde fois. Sans cause, la conduite seule.
 *
 * @param {unknown} motif
 */
export function conduiteDuDemarrageEchoue(motif) {
  const conduite = conduiteHumaine(C.applicationEnEchec);
  if (typeof motif !== "string" || motif.trim() === "") return conduite;
  const cause = motif.replace(CARACTERES_DE_CONTROLE, " ").trim().slice(0, CAUSE_AFFICHEE_MAX);
  return `${conduite} Cause : ${cause}`;
}
