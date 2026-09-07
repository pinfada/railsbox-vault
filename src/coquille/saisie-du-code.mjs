// La SAISIE du code de récupération, contrôlée EN DIRECT (#162, ADR 0029).
//
// L'[ADR 0025](../../docs/decisions/0025-moyen-de-recuperation.md) § « Risques » désigne nommément
// cette tranche : « si un usage montrait que vingt-huit symboles sont trop pénibles à recopier, ce
// qui change est l'INTERFACE (#24) — la découpe affichée, l'aide à la saisie, un contrôle en direct
// par la somme — et non le tirage ». Les trois sont ici, et rien d'autre.
//
// ## Ce que le contrôle en direct décide, et ce qu'il ne décide pas
//
// La somme de contrôle ISO 7064 détecte un symbole mal lu et deux voisins échangés. Elle ne dit
// RIEN de la justesse du code : un code bien formé mais étranger passe la somme et sera refusé par
// l'enveloppe. Les deux refus restent donc distincts, et la distinction est la moitié du service
// rendu à l'utilisateur :
//
//  - `VAULT_DERIVATION_CODE_MAL_RECOPIE` — « relisez la feuille » : rien n'a été dérivé, rien n'a
//    été tenté, et le remède est entre les mains de qui lit ;
//  - `VAULT_ENVELOPPE_CLE_REFUSEE` — « ce code n'ouvre pas ce coffre » : la dérivation a eu lieu,
//    l'enveloppe a tranché, et le remède est ailleurs.
//
// Les confondre ferait chercher une faute de recopie là où il y a un mauvais coffre, et
// réciproquement. **Le contrôle a lieu AVANT tout envoi** : le Worker de confiance ne voit jamais
// un code dont la somme ne vérifie pas, et l'utilisateur n'attend pas une dérivation pour
// apprendre qu'il a mal lu un « 5 ».
//
// ## Ce module n'écrit RIEN
//
// Il ne tient aucun état entre deux appels : chaque frappe rend un verdict à partir du texte
// courant, et rien n'en reste. Une aide à la saisie qui aurait mémorisé « le dernier code valide »
// pour éviter un recalcul aurait fait vivre le secret plus longtemps que la frappe, dans un objet
// que personne n'aurait pensé à effacer.

import {
  ALPHABET_CROCKFORD,
  SYMBOLES_PAR_GROUPE,
  SYMBOLES_TOTAL,
  balayerSaisie,
  sommeDeControleValide,
} from "../vm/derivation/code-de-recuperation.mjs";
import { DERIVATION_ERROR_CODES } from "../vm/derivation/derivation-errors.mjs";

/** Le séparateur de groupes, celui que l'encodeur écrit. La découpe affichée emploie le même. */
export const SEPARATEUR = "-";

/** Nombre de groupes attendus : sept, de quatre symboles. Dérivé, jamais recopié. */
export const GROUPES = SYMBOLES_TOTAL / SYMBOLES_PAR_GROUPE;

/**
 * La DÉCOUPE affichée : ce que le produit a LU de la saisie, réécrit en sept groupes de quatre.
 *
 * Elle est l'aide à la saisie tout entière. L'utilisateur peut taper ses vingt-huit symboles d'un
 * trait, avec des espaces, en minuscules, en confondant `O` et `0` — la découpe lui rend ce que le
 * décodeur a compris, dans la forme exacte où le produit l'avait écrit sur la feuille. Voir la
 * différence est plus utile que lire une règle de saisie.
 *
 * @param {number[]} symboles valeurs de symbole, telles que `balayerSaisie` les rend
 */
export function decouper(symboles) {
  const lettres = symboles.map((valeur) => ALPHABET_CROCKFORD[valeur]).join("");
  const groupes = [];
  for (let debut = 0; debut < lettres.length; debut += SYMBOLES_PAR_GROUPE) {
    groupes.push(lettres.slice(debut, debut + SYMBOLES_PAR_GROUPE));
  }
  return groupes.join(SEPARATEUR);
}

/**
 * Les quatre verdicts d'une saisie, et rien entre eux.
 *
 * `incomplet` et `malRecopie` ne se confondent pas : le premier dit « continuez », le second dit
 * « relisez ». Une interface qui rendrait « invalide » aux deux ferait clignoter un refus à la
 * première frappe, ce qu'aucun utilisateur ne lit plus au bout de trois codes.
 */
export const VERDICTS = Object.freeze({
  vide: "vide",
  incomplet: "incomplet",
  malRecopie: "mal-recopie",
  pret: "pret",
});

/**
 * L'ÉTAT d'une saisie, calculé à chaque frappe. Il ne lève jamais.
 *
 * `envoyable` est la seule chose que l'interface consulte pour ouvrir ou fermer son bouton, et
 * c'est délibéré : la condition d'envoi ne doit exister qu'à UN endroit, sans quoi une seconde
 * lecture finit par diverger de la première. Elle est vraie exactement quand le verdict est `pret`.
 *
 * @param {unknown} texte la saisie brute, telle que le champ la porte
 * @returns {{ verdict: string, symbolesLus: number, decoupe: string, envoyable: boolean,
 *             code: string | null, message: string }}
 */
export function etatDeLaSaisie(texte) {
  const { symboles, signeRefuse } = balayerSaisie(texte);
  const decoupe = decouper(symboles);

  if (signeRefuse !== null) return refusDUnSigne(symboles.length, decoupe, signeRefuse);
  if (symboles.length === 0) return saisieVide();
  if (symboles.length < SYMBOLES_TOTAL) return saisieIncomplete(symboles.length, decoupe);
  if (symboles.length > SYMBOLES_TOTAL) return saisieTropLongue(symboles.length, decoupe);
  if (!sommeDeControleValide(symboles)) return sommeFausse(symboles.length, decoupe);
  return Object.freeze({
    verdict: VERDICTS.pret,
    symbolesLus: symboles.length,
    decoupe,
    envoyable: true,
    code: null,
    message: "Code complet et cohérent. Reste à savoir s'il ouvre CE coffre.",
  });
}

/** Le signe hors table est NOMMÉ ; rien d'autre de la saisie ne l'est (ADR 0025, décision 2). */
function refusDUnSigne(symbolesLus, decoupe, signeRefuse) {
  return refus(
    symbolesLus,
    decoupe,
    `Le signe « ${signeRefuse} » n'appartient pas au code : il n'emploie que des chiffres et des ` +
      `lettres, sans « I », « L », « O » ni « U ». Les espaces et les tirets sont libres.`,
  );
}

/** Rien n'a été tapé : la coquille dit quoi faire, et ne refuse rien. */
function saisieVide() {
  return Object.freeze({
    verdict: VERDICTS.vide,
    symbolesLus: 0,
    decoupe: "",
    envoyable: false,
    code: null,
    message: `Recopiez les ${SYMBOLES_TOTAL} symboles de la feuille, en ${GROUPES} groupes de ${SYMBOLES_PAR_GROUPE}. Les séparateurs et la casse sont libres.`,
  });
}

/** En cours de frappe : « continuez », et surtout PAS un refus — voir `VERDICTS`. */
function saisieIncomplete(symbolesLus, decoupe) {
  return Object.freeze({
    verdict: VERDICTS.incomplet,
    symbolesLus,
    decoupe,
    envoyable: false,
    code: null,
    message: `${symbolesLus} symbole(s) sur ${SYMBOLES_TOTAL}.`,
  });
}

/**
 * Trop de symboles : refusé POUR SA LONGUEUR, et le motif compte.
 *
 * La somme de contrôle refuserait aussi — elle n'accepte que vingt-huit symboles —, mais sous un
 * message qui enverrait RELIRE là où il faut EFFACER. La campagne de mutation a fait survivre un
 * mutant sur cette borne exactement parce que les deux chemins rendaient le même verdict.
 */
function saisieTropLongue(symbolesLus, decoupe) {
  return refus(
    symbolesLus,
    decoupe,
    `${symbolesLus} symboles au lieu de ${SYMBOLES_TOTAL} : il y en a de trop.`,
  );
}

/** La somme ISO 7064 ne vérifie pas : un symbole mal lu, ou deux voisins échangés. */
function sommeFausse(symbolesLus, decoupe) {
  return refus(
    symbolesLus,
    decoupe,
    "La somme de contrôle ne vérifie pas : un symbole a été mal lu, ou deux voisins ont été " +
      "échangés. Relisez la feuille. Ce n'est PAS le refus d'un code étranger — celui-là ne " +
      "tombe qu'après une tentative d'ouverture.",
  );
}

/**
 * Un refus de saisie, sous le code que le produit rend déjà pour la même faute.
 *
 * Le code est celui de `code-de-recuperation.mjs`, pas un code d'interface : ce que l'utilisateur
 * voit à l'écran et ce que l'épreuve lit dans un refus doivent porter le MÊME nom, sans quoi le
 * dossier décrirait deux refus là où il n'y en a qu'un.
 */
function refus(symbolesLus, decoupe, message) {
  return Object.freeze({
    verdict: VERDICTS.malRecopie,
    symbolesLus,
    decoupe,
    envoyable: false,
    code: DERIVATION_ERROR_CODES.codeMalRecopie,
    message,
  });
}
