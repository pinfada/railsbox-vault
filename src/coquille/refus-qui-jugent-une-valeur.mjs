// Quels refus jugent la VALEUR qu'une personne a saisie (#266 B2-3) — et lesquels n'ont rien à lui
// reprocher. Seuls les premiers accusent un champ ; un refus d'état (coffre déjà ouvert dans un autre
// onglet, installation inachevée…) s'affiche sans le marquer.
//
// Pur, comme le reste du répertoire : ni DOM, ni stockage, ni horloge.

import { DERIVATION_ERROR_CODES as D } from "../vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES as E } from "../vm/enveloppe/enveloppe-errors.mjs";
import { conduiteHumaine } from "./conduites-du-parcours.mjs";
import { CODE_PHRASE_FAIBLE } from "./politique-de-phrase.mjs";

/** Les codes qui jugent une phrase ou un code tapé : une clé refusée, rejouée, une phrase refusée ou faible, un code mal recopié. */
const CODES_QUI_JUGENT_UNE_VALEUR = Object.freeze([
  E.cleRefusee,
  E.rejeu,
  D.phraseRefusee,
  D.codeMalRecopie,
  CODE_PHRASE_FAIBLE,
]);

const CONDUITES_QUI_JUGENT_UNE_VALEUR = new Set(
  CODES_QUI_JUGENT_UNE_VALEUR.map((code) => conduiteHumaine(code)),
);

/** Le texte affiché est-il celui d'un refus qui juge la valeur saisie ? */
export function refusJugeLaValeur(texte) {
  return CONDUITES_QUI_JUGENT_UNE_VALEUR.has(String(texte ?? ""));
}
