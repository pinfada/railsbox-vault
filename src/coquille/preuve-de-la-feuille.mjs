// La PREUVE DE LA FEUILLE (#239, ADR 0040 amendé le 18/09/2026, note à l'ADR 0030).
//
// Une feuille de récupération est ÉPROUVÉE quand son code a OUVERT ce coffre sur cet appareil. Ce
// n'est pas la page qui le dit — un message de la page se forge aussi facilement que `parcours.json`
// se réécrit (VULN-04) —, c'est le Worker de confiance qui le CONSTATE : `ouvrirParLeCode` lui rend
// l'identifiant de l'emplacement qui a ouvert, et il l'inscrit ici.
//
// ## Où, et sous quelle forme
//
// Dans le SECTEUR 1 du volume `coquille` : trente-deux secteurs scellés sous la clé de volume, dont
// seul le secteur 0 était écrit (le motif de `ecrireEtAcquitter`). L'enregistrement est scellé comme
// tout le volume, et il est écrit AVANT la barrière que l'ouverture acquitte déjà : la même `flush`
// le rend durable.
//
//   octets 0 à 7    la marque `RBVFEUIL`
//   octet 8         le format, 1
//   octet 9         le nombre d'identifiants, de 0 à 8
//   octets 10 à 73  huit places de huit octets, les identifiants d'emplacement, du plus ancien au
//                   plus récent ; les places libres et le reste du secteur sont à zéro
//
// ## Un secteur jamais écrit
//
// Un volume v3 naît ENTIÈREMENT scellé, zéros compris (`opfs-volume-ouverture.mjs`, « un secteur
// jamais écrit n'existe pas en v3 ») : la lecture du secteur 1 d'un coffre d'avant cette correction
// rend donc cinq cent douze zéros authentifiés, jamais un refus. Ce module lit « que des zéros »
// comme « aucune feuille éprouvée » — l'état ordinaire d'un coffre ancien, restauré ou neuf —, et
// jamais comme une erreur. Une marque inconnue ou un format à venir se lisent de même, et sont
// réécrits au format 1 à la prochaine inscription. Une lecture qui ÉCHOUE (sceau refusé, support
// perdu) n'est pas un secteur vierge : elle ne prouve rien, et son erreur est RENDUE au Worker, qui la
// publie comme un refus typé sans refermer le coffre (`constaterALOuverture`).
//
// Pur à l'exception des deux fonctions qui prennent un `backend` : ni DOM, ni horloge.

import { SECTOR_SIZE } from "../vm/block-geometry.mjs";
import {
  IDENTIFIANT_EMPLACEMENT_OCTETS,
  TYPES_KEK,
  identifiantEmplacementEnOctets,
  identifiantEmplacementEnTexte,
} from "../vm/enveloppe/identite-enveloppe.mjs";

/** Le secteur du volume `coquille` qui porte la preuve. Le secteur 0 reste au motif de barrière. */
export const SECTEUR_DE_LA_PREUVE = 1;

/** La marque des huit premiers octets : « RailsBox Vault, FEUILLe ». */
export const MARQUE_DE_LA_PREUVE = Object.freeze([...new TextEncoder().encode("RBVFEUIL")]);

/** Le format de l'enregistrement. Un autre format se lit comme « aucune feuille éprouvée ». */
export const FORMAT_DE_LA_PREUVE = 1;

/** Huit identifiants au plus : autant que d'emplacements dans une enveloppe (ADR 0020). */
export const IDENTIFIANTS_MAX = 8;

const DEBUT_DES_IDENTIFIANTS = MARQUE_DE_LA_PREUVE.length + 2;

/** Ce que la lecture a trouvé : un enregistrement, un secteur vierge, ou autre chose. */
export const ETATS_DE_LA_PREUVE = Object.freeze({
  inscrite: "inscrite",
  vierge: "vierge",
  inconnue: "inconnue",
});

/**
 * Encode la liste des identifiants éprouvés en un secteur entier.
 *
 * @param {readonly string[]} identifiants au plus `IDENTIFIANTS_MAX`, chacun de seize chiffres
 *   hexadécimaux
 * @returns {Uint8Array} `SECTOR_SIZE` octets
 */
export function encoderLaPreuve(identifiants) {
  if (identifiants.length > IDENTIFIANTS_MAX) {
    throw new RangeError(
      `La preuve porte au plus ${IDENTIFIANTS_MAX} identifiants, reçu ${identifiants.length}.`,
    );
  }
  const secteur = new Uint8Array(SECTOR_SIZE);
  secteur.set(MARQUE_DE_LA_PREUVE, 0);
  secteur[MARQUE_DE_LA_PREUVE.length] = FORMAT_DE_LA_PREUVE;
  secteur[MARQUE_DE_LA_PREUVE.length + 1] = identifiants.length;
  identifiants.forEach((identifiant, rang) => {
    secteur.set(
      identifiantEmplacementEnOctets(identifiant),
      DEBUT_DES_IDENTIFIANTS + rang * IDENTIFIANT_EMPLACEMENT_OCTETS,
    );
  });
  return secteur;
}

/**
 * Relit un secteur. Rien de ce qui n'est pas EXACTEMENT un enregistrement du format 1 ne donne
 * d'identifiant : un secteur vierge, une marque étrangère, un compte hors borne rendent une liste
 * vide, et l'état dit lequel.
 *
 * @param {Uint8Array} secteur
 * @returns {{ etat: string, identifiants: readonly string[] }}
 */
export function lireLaPreuve(secteur) {
  const vide = (etat) => Object.freeze({ etat, identifiants: Object.freeze([]) });
  if (secteur.every((octet) => octet === 0)) return vide(ETATS_DE_LA_PREUVE.vierge);
  const marque = MARQUE_DE_LA_PREUVE.every((octet, rang) => secteur[rang] === octet);
  const format = secteur[MARQUE_DE_LA_PREUVE.length];
  const nombre = secteur[MARQUE_DE_LA_PREUVE.length + 1];
  if (!marque || format !== FORMAT_DE_LA_PREUVE || nombre > IDENTIFIANTS_MAX) {
    return vide(ETATS_DE_LA_PREUVE.inconnue);
  }
  const identifiants = [];
  for (let rang = 0; rang < nombre; rang += 1) {
    const debut = DEBUT_DES_IDENTIFIANTS + rang * IDENTIFIANT_EMPLACEMENT_OCTETS;
    identifiants.push(
      identifiantEmplacementEnTexte(secteur.slice(debut, debut + IDENTIFIANT_EMPLACEMENT_OCTETS)),
    );
  }
  return Object.freeze({
    etat: ETATS_DE_LA_PREUVE.inscrite,
    identifiants: Object.freeze(identifiants),
  });
}

/**
 * La liste APRÈS l'inscription d'un identifiant : sans doublon, le plus récent en dernier, et les
 * plus anciens retirés au-delà de huit. Rend une NOUVELLE liste.
 *
 * @param {readonly string[]} identifiants
 * @param {string} identifiant
 */
export function listeApresInscription(identifiants, identifiant) {
  const suite = [...identifiants.filter((present) => present !== identifiant), identifiant];
  return Object.freeze(suite.slice(-IDENTIFIANTS_MAX));
}

/**
 * La feuille est-elle éprouvée ? Vrai si un identifiant inscrit est ENCORE un emplacement de
 * récupération (type 4) de l'enveloppe : une feuille retirée (#218, révocation) fait tomber la
 * preuve sans autre règle.
 *
 * @param {readonly string[]} identifiants
 * @param {{ emplacements?: { typeKek: number, identifiantEmplacement: string }[] }} inventaire
 */
export function feuilleEprouvee(identifiants, inventaire) {
  const codes = new Set(
    (inventaire?.emplacements ?? [])
      .filter((emplacement) => emplacement.typeKek === TYPES_KEK.recuperation)
      .map((emplacement) => emplacement.identifiantEmplacement),
  );
  return identifiants.some((identifiant) => codes.has(identifiant));
}

/**
 * LIT la preuve dans le volume `coquille` ouvert.
 *
 * @param {{ read: (offset: number, length: number) => Promise<Uint8Array> }} backend
 */
export async function lireLaPreuveDuVolume(backend) {
  return lireLaPreuve(await backend.read(SECTEUR_DE_LA_PREUVE * SECTOR_SIZE, SECTOR_SIZE));
}

/**
 * INSCRIT l'identifiant qui vient d'ouvrir. N'écrit rien si la liste est déjà à jour ; ne `flush`
 * pas : la barrière que l'ouverture acquitte ensuite (`ecrireEtAcquitter`) rend l'écriture durable.
 *
 * @param {{ write: (offset: number, octets: Uint8Array) => Promise<unknown> }} backend
 * @param {readonly string[]} identifiants la liste lue à l'ouverture
 * @param {string} identifiant
 * @returns {Promise<readonly string[]>} la liste inscrite
 */
export async function inscrireLaPreuve(backend, identifiants, identifiant) {
  const suite = listeApresInscription(identifiants, identifiant);
  const inchangee =
    suite.length === identifiants.length &&
    suite.every((present, rang) => present === identifiants[rang]);
  if (!inchangee) {
    await backend.write(SECTEUR_DE_LA_PREUVE * SECTOR_SIZE, encoderLaPreuve(suite));
  }
  return suite;
}

/**
 * Ce que le Worker de confiance fait de la preuve à CHAQUE ouverture : la lire, et y inscrire
 * l'emplacement qui vient d'ouvrir quand c'est un code de récupération. Appelée seulement APRÈS que
 * le volume s'est ouvert : une ouverture refusée n'écrit rien.
 *
 * Elle ne fait JAMAIS échouer l'ouverture (revue de sécurité de la PR #244) : le coffre est ouvert, et
 * une preuve illisible ou non inscrite n'en retire rien — elle ne coûte qu'une saisie du code. L'erreur
 * n'est pas avalée pour autant : elle est RENDUE, et le Worker la publie comme un refus typé. Une
 * lecture qui échoue ne prouve rien (liste vide) ; une inscription qui échoue laisse la liste LUE,
 * dont chaque identifiant a déjà ouvert ce coffre.
 *
 * @param {{ read: Function, write: Function }} backend le volume `coquille`, ouvert
 * @param {string | null} identifiant l'emplacement de récupération qui a ouvert, ou `null` pour une
 *   phrase, une passkey ou une création
 * @returns {Promise<{ identifiants: readonly string[], erreur: Error | null }>}
 */
export async function constaterALOuverture(backend, identifiant) {
  let lue;
  try {
    lue = await lireLaPreuveDuVolume(backend);
  } catch (erreur) {
    return Object.freeze({ identifiants: Object.freeze([]), erreur });
  }
  if (identifiant === null) return Object.freeze({ identifiants: lue.identifiants, erreur: null });
  try {
    const identifiants = await inscrireLaPreuve(backend, lue.identifiants, identifiant);
    return Object.freeze({ identifiants, erreur: null });
  } catch (erreur) {
    return Object.freeze({ identifiants: lue.identifiants, erreur });
  }
}

/**
 * Le CONSTAT publié : la liste éprouvée, comparée à l'enveloppe du moment. Un inventaire qui échoue
 * rend « non éprouvée » et l'erreur, que le Worker publie ; il ne fait pas échouer l'ouverture.
 *
 * @param {readonly string[]} identifiants
 * @param {() => Promise<object>} inventorier
 * @returns {Promise<{ eprouvee: boolean, erreur: Error | null }>}
 */
export async function feuilleConstatee(identifiants, inventorier) {
  try {
    return Object.freeze({
      eprouvee: feuilleEprouvee(identifiants, await inventorier()),
      erreur: null,
    });
  } catch (erreur) {
    return Object.freeze({ eprouvee: false, erreur });
  }
}
