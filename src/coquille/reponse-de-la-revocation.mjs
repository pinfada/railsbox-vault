// Ce que la page tient pour VRAI d'une réponse du Worker (#310, ADR 0049) : classer l'issue de
// l'envoi (`evenementDeLaReponse`) et normaliser l'inventaire (`normaliserLInventaire`).
//
// Le canal ne garantit que la CORRÉLATION (`canal-de-confiance.mjs`) : ni le type, ni la forme, ni les
// bornes. Les deux fonctions sont TOTALES — aucune entrée ne les fait lever — et DÉFENSIVES : chaque
// propriété est lue UNE seule fois, sous `try`, les tailles sont vérifiées AVANT toute itération, et
// le résultat est une copie profondément gelée, sans alias vers l'entrée.
//
// Aucune détection de `Proxy` n'est promise (indétectable en général) : le contrat de sécurité vaut
// pour les valeurs issues de la désérialisation structurée du canal (ADR 0028), qui ne transmet ni
// `Proxy` ni accesseur. Un script de même origine est hors périmètre (ADR 0039 § 5).

import { TYPES_PRIVILEGIES } from "./contrat-de-messages.mjs";
import { ETATS_DU_VOLUME } from "./etat-de-la-coquille.mjs";
import { moyensProposes } from "./moyens-de-deverrouillage.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import {
  EMPLACEMENTS_MAX,
  IDENTIFIANT_EMPLACEMENT_OCTETS,
  PARAMETRES_MAX,
  TYPES_KEK,
} from "../vm/enveloppe/identite-enveloppe.mjs";

const ECHEC = Object.freeze({ ok: false });

const entierSur = (valeur, minimum, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(valeur) && valeur >= minimum && valeur <= maximum;

const objetNonTableau = (valeur) =>
  valeur !== null && typeof valeur === "object" && !Array.isArray(valeur);

// --- L'issue de l'envoi -----------------------------------------------------------------------------

/** Le code d'une erreur, ou `null` : une chaîne non vide, lue une fois, sous `try`. */
export function codeDeLErreur(erreur) {
  try {
    const code = erreur?.code;
    return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : null;
  } catch {
    return null;
  }
}

/** Les comptes d'un bilan : un objet de noms → entiers ≥ 1, au plus huit clés, de somme `attendu`. */
function comptesCoherents(comptes, attendu) {
  if (!objetNonTableau(comptes)) return false;
  const cles = Object.keys(comptes);
  if (cles.length > EMPLACEMENTS_MAX) return false;
  let somme = 0;
  for (const cle of cles) {
    const nombre = comptes[cle];
    if (!entierSur(nombre, 1, EMPLACEMENTS_MAX)) return false;
    somme += nombre;
  }
  return somme === attendu;
}

/**
 * Le contrat du SUCCÈS (R8.6) : type, entiers sûrs et bornés, cohérence des comptes avec l'invariant
 * du Worker (`revoquerToutSauf` conserve EXACTEMENT un emplacement ; plafond de huit).
 */
function succesValide(valeur) {
  if (!objetNonTableau(valeur)) return false;
  const lu = {
    type: valeur.type,
    version: valeur.versionEnveloppe,
    retires: valeur.nombreRetires,
    restants: valeur.nombreRestants,
    detailRetires: valeur.retires,
    detailRestants: valeur.restants,
    copie: valeur.copieDeSauvegardeRetiree,
    etat: valeur.etat,
    barrieres: valeur.barrieres,
  };
  return (
    lu.type === TYPES_PRIVILEGIES.revoquerEnUrgenceReponse &&
    entierSur(lu.version, 1) &&
    entierSur(lu.retires, 0, EMPLACEMENTS_MAX - 1) &&
    lu.restants === 1 &&
    comptesCoherents(lu.detailRestants, lu.restants) &&
    comptesCoherents(lu.detailRetires, lu.retires) &&
    typeof lu.copie === "boolean" &&
    lu.etat === ETATS_DU_VOLUME.ouvert &&
    entierSur(lu.barrieres, 0)
  );
}

function classerLErreur(erreur) {
  const code = codeDeLErreur(erreur);
  if (code === CODES_REFUS_COQUILLE.workerMort) return "worker-mort";
  if (code === CODES_REFUS_COQUILLE.gesteRompu) return "worker-rompu";
  return code === null ? "erreur-sans-code" : "refus-type";
}

/**
 * Classe l'issue de `envoyer` en UN des événements de réponse. TOTALE : jamais de levée.
 * `delai-depasse` n'est pas produit : le canal rend `workerMort` pour le silence (L8).
 *
 * @param {{ ok: boolean, valeur?: unknown, erreur?: unknown }} resultat
 * @returns {"reponse-de-succes" | "refus-type" | "worker-mort" | "worker-rompu"
 *           | "reponse-malformee" | "erreur-sans-code"}
 */
export function evenementDeLaReponse(resultat) {
  try {
    if (!objetNonTableau(resultat)) return "reponse-malformee";
    const ok = resultat.ok;
    if (ok === true)
      return succesValide(resultat.valeur) ? "reponse-de-succes" : "reponse-malformee";
    if (ok === false) return classerLErreur(resultat.erreur);
    return "reponse-malformee";
  } catch {
    return "reponse-malformee";
  }
}

// --- L'inventaire -----------------------------------------------------------------------------------

const MOTIF_DU_CODE_DE_REFUS = /^VAULT_[A-Z0-9_]{1,64}$/;
const MOTIF_DE_L_IDENTIFIANT = new RegExp(`^[0-9a-f]{${IDENTIFIANT_EMPLACEMENT_OCTETS * 2}}$`);
const MOTIF_HEXADECIMAL = /^(?:[0-9a-f]{2})*$/;

/** N3 : un refus est `null` ou `{ code }` ; le MESSAGE du Worker n'est pas propagé. */
function refusNormalise(refus) {
  if (refus === null) return null;
  if (!objetNonTableau(refus)) throw ECHEC;
  const code = refus.code;
  if (typeof code !== "string" || !MOTIF_DU_CODE_DE_REFUS.test(code)) throw ECHEC;
  return Object.freeze({ code });
}

/** N5 : un emplacement, reconstruit champ par champ, hors alias. */
function emplacementNormalise(brut) {
  if (!objetNonTableau(brut)) throw ECHEC;
  const typeKek = brut.typeKek;
  const identifiant = brut.identifiantEmplacement;
  const parametres = brut.parametresHex;
  if (!entierSur(typeKek, 0, 255)) throw ECHEC;
  if (typeof identifiant !== "string" || !MOTIF_DE_L_IDENTIFIANT.test(identifiant)) throw ECHEC;
  if (typeKek === TYPES_KEK.recuperation) {
    if (parametres !== undefined) throw ECHEC;
    return Object.freeze({ typeKek, identifiantEmplacement: identifiant });
  }
  const valide =
    typeof parametres === "string" &&
    parametres.length <= PARAMETRES_MAX * 2 &&
    MOTIF_HEXADECIMAL.test(parametres);
  if (!valide) throw ECHEC;
  return Object.freeze({ typeKek, identifiantEmplacement: identifiant, parametresHex: parametres });
}

/** N4 : la taille est lue UNE fois et bornée AVANT toute itération (un `length` énorme ne boucle pas). */
function emplacementsNormalises(brut, attendusVides) {
  if (!Array.isArray(brut)) throw ECHEC;
  const longueur = brut.length;
  if (!entierSur(longueur, 0, EMPLACEMENTS_MAX)) throw ECHEC;
  if (attendusVides && longueur !== 0) throw ECHEC;
  const copie = [];
  const vus = new Set();
  for (let rang = 0; rang < longueur; rang += 1) {
    const emplacement = emplacementNormalise(brut[rang]);
    if (vus.has(emplacement.identifiantEmplacement)) throw ECHEC;
    vus.add(emplacement.identifiantEmplacement);
    copie.push(emplacement);
  }
  return Object.freeze(copie);
}

/** N8, N9 : le constat n'existe que coffre OUVERT, et alors il est un booléen OBLIGATOIRE. */
function constatNormalise(ouvert, present, refus, feuille) {
  if (!ouvert) return null;
  if (!present || refus !== null) throw ECHEC;
  if (typeof feuille !== "boolean") throw ECHEC;
  return Object.freeze({ feuilleEprouvee: feuille });
}

function normaliser(reponse, ouvert) {
  if (!objetNonTableau(reponse)) throw ECHEC;
  const lu = {
    type: reponse.type,
    present: reponse.present,
    refus: reponse.refus,
    feuille: reponse.feuilleEprouvee,
    version: reponse.versionEnveloppe,
    emplacements: reponse.emplacements,
  };
  if (lu.type !== TYPES_PRIVILEGIES.inventaireReponse) throw ECHEC;
  if (typeof lu.present !== "boolean") throw ECHEC;
  const refus = refusNormalise(lu.refus);
  const parametres = emplacementsNormalises(lu.emplacements, !lu.present || refus !== null);
  if (lu.present && refus === null && !entierSur(lu.version, 1)) throw ECHEC;
  const constat = constatNormalise(ouvert, lu.present, refus, lu.feuille);
  const proposes = moyensProposes({ emplacements: parametres, versionEnveloppe: null });
  const publique = Object.freeze({
    present: lu.present,
    moyens: Object.freeze(proposes.moyens.map((moyen) => moyen.nom)),
    nombreDeCodes: proposes.nombreDeCodes,
    typesInconnus: Object.freeze(proposes.inconnus.map((inconnu) => inconnu.typeKek)),
    parametres,
    refus,
    versionEnveloppe: lu.present && refus === null ? lu.version : null,
  });
  return Object.freeze({ public: publique, constat });
}

/**
 * Normalise une réponse d'inventaire en instantané GELÉ, borné, sans alias. TOTALE (N12).
 *
 * @param {unknown} reponse la valeur rendue par le canal
 * @param {{ ouvert: boolean }} contexte `ouvert` vient de la PHASE, jamais de la réponse
 * @returns {{ ok: true, donnees: { public: object, constat: object | null } } | { ok: false }}
 */
export function normaliserLInventaire(reponse, { ouvert } = {}) {
  if (typeof ouvert !== "boolean") throw new TypeError("« ouvert » doit être un booléen.");
  try {
    return Object.freeze({ ok: true, donnees: normaliser(reponse, ouvert) });
  } catch {
    return ECHEC;
  }
}
