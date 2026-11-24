// Ce que l'ÉTAT de la révocation décide de l'écran du parcours (#265, ADR 0049 § C2, C2-1′, S3).
//
// La page ne lit RIEN d'autre que l'état : le coffre (ouvert, fermé, absent, refusé), les moyens, le
// compte des codes et le constat de la feuille viennent des deux PORTES (`lirePublic`, `lireLeConstat`),
// jamais d'un miroir, d'une ligne de texte ou d'un drapeau parallèle. Pur : éprouvé et muté dans Node.

import { COFFRE, REFUS_D_INVENTAIRE } from "./parcours.mjs";
import { vueDe, lireLeConstat, lirePublic } from "./vue-de-la-revocation.mjs";

/** Les phases où le coffre est OUVERT : l'ouverture a eu lieu dans cette instance. */
const OUVERTES = Object.freeze(["SL", "SE", "SM", "RL", "RE", "RM", "P", "C", "V", "K", "I"]);

/** L'écran du parcours que chaque écran imposé par l'état appelle. */
const ECRAN_DE = Object.freeze({
  chargement: "chargement",
  "chargement-apres-revocation": "chargement",
  relire: "etat-du-coffre",
  "relire-apres-revocation": "etat-du-coffre",
  "modification-en-cours": "etat-du-coffre",
  "modification-en-cours-apres-revocation": "etat-du-coffre",
  "revoquer-en-cours": "etat-du-coffre",
  "revocation-incertaine": "etat-du-coffre",
  termine: "etat-du-coffre",
});

/** Ces deux écrans ne s'imposent qu'à l'étape 9 : ailleurs, la personne retrouve son application. */
const A_L_ETAPE_9 = Object.freeze(["termine", "revocation-incertaine"]);

function coffreDeLEtat(etat) {
  if (OUVERTES.includes(etat.phase)) return COFFRE.ouvert;
  if (etat.phase !== "FC") return COFFRE.inconnu;
  const donnees = lirePublic(etat);
  const code = donnees.refus?.code ?? null;
  if (REFUS_D_INVENTAIRE.includes(code)) return COFFRE.refuse;
  return donnees.moyens.length > 0 ? COFFRE.verrouille : COFFRE.absent;
}

/**
 * Les données de décision de `ecranCourant`, lues par les deux portes. `nombreDeCodes` reste indéfini
 * quand la page ne le sait pas : aucune valeur par défaut ne rend une donnée fiable (D3, I6).
 *
 * @param {{ etat: object, pointeur: number | null }} entree
 */
export function observationDeLEtat({ etat }) {
  const donnees = lirePublic(etat);
  const constat = lireLeConstat(etat);
  const vue = vueDe(etat);
  return {
    coffre: coffreDeLEtat(etat),
    moyens: donnees === null ? [] : [...donnees.moyens],
    nombreDeCodes: donnees === null ? undefined : donnees.nombreDeCodes,
    feuilleEprouvee: constat?.feuilleEprouvee === true,
    refus: donnees?.refus?.code ?? null,
    fin: etat.phase === "K" ? "termine" : vue.finDisponible,
  };
}

/** L'écran que l'ÉTAT impose, ou `null` : alors c'est le parcours qui choisit. */
export function ecranImposeDeLEtat(vue, pointeur) {
  const cle = vue.ecranImpose;
  if (cle === null) return null;
  if (A_L_ETAPE_9.includes(cle) && pointeur !== 9 && pointeur !== null) return null;
  return ECRAN_DE[cle];
}
