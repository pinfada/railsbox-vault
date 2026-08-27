// Erreurs contractuelles du format chiffré (#17, ADR 0015).
//
// Elles forment une famille DISTINCTE de `storage-errors.mjs`, pour la raison que l'ADR 0007 a déjà
// tranchée entre stockage et manifeste : le stockage décrit un état du SUPPORT, le format chiffré
// une propriété de SÉCURITÉ. Les fondre effacerait des remèdes qui n'ont rien de commun — libérer de
// la place d'un côté, restaurer une sauvegarde ou changer de clé de l'autre. La forme transportable
// est en revanche la même (`code`, message français, contexte, `toJSON`), pour qu'un refus survive
// au passage d'un `postMessage`.
//
// Chaque erreur nomme les MENACES qu'elle couvre. Ce champ est là pour une raison précise, et sa
// nuance est le point le plus important de ce fichier : **modification et déplacement sont
// cryptographiquement indiscernables**. Quand l'étiquette AES-GCM ne vérifie pas, rien ne dit si un
// octet du chiffré a bougé ou si le bloc est présenté sous une autre adresse — les deux entrent dans
// le même calcul. Le modèle refuse dans les deux cas ; il ne prétend pas savoir lequel. `menaces`
// porte donc la LISTE des menaces qu'un refus couvre, jamais un diagnostic inventé.
//
// Les trois autres menaces, elles, sont ÉTABLIES : rejeu, troncature et mélange ne sont constatés
// qu'APRÈS que l'étiquette de la racine a vérifié, donc sur un en-tête authentique. C'est pourquoi
// l'en-tête de racine est les données associées et l'empreinte des entrées le clair : vérifier
// d'abord, classer ensuite.

/** Les cinq menaces nommées par l'ADR 0015. Un refus en cite au moins une. */
export const MENACES = Object.freeze({
  modification: "modification",
  deplacement: "deplacement",
  rejeu: "rejeu",
  troncature: "troncature",
  melange: "melange",
});

export const CRYPTO_ERROR_CODES = Object.freeze({
  /**
   * L'étiquette ne vérifie pas. Couvre MODIFICATION et DÉPLACEMENT, qui ne se distinguent pas :
   * l'un change le chiffré, l'autre les données associées, et GCM ne rend qu'un seul verdict.
   */
  sealRejected: "VAULT_CRYPTO_SCEAU_REFUSE",
  /**
   * Le nonce conservé avec le sceau n'encode pas la génération et le rang de l'identité présentée.
   * Établi AVANT tout calcul cryptographique : le nonce se décrit lui-même.
   */
  identityMismatch: "VAULT_CRYPTO_IDENTITE_INCOHERENTE",
  /** Séquence ou génération authentifiée inférieure au minimum exigé par l'appelant. */
  replay: "VAULT_CRYPTO_REJEU",
  /** Le nombre d'entrées ou la longueur de charge trouvés diffèrent de ce que la racine authentifie. */
  truncation: "VAULT_CRYPTO_TRONCATURE",
  /** Le compte est juste, l'ensemble ne l'est pas : au moins une entrée n'est pas de cette génération. */
  mixing: "VAULT_CRYPTO_MELANGE",
  /** Deux entrées d'une même génération portent le même rang : ce serait une réutilisation de nonce. */
  nonceReuse: "VAULT_CRYPTO_NONCE_REUTILISE",
  /** Le budget de scellements de cette clé est atteint (NIST SP 800-38D, § 8.3). Changer de clé. */
  keyBudget: "VAULT_CRYPTO_BUDGET_DE_CLE",
  /** Entrée structurellement inadmissible : largeur, type, longueur. Jamais complétée ni arrondie. */
  malformed: "VAULT_CRYPTO_MALFORME",
  /** Algorithme autre que l'unique algorithme admis par cette version de la spécification. */
  algorithmUnsupported: "VAULT_CRYPTO_ALGORITHME_INCONNU",
});

const KNOWN_CODES = new Set(Object.values(CRYPTO_ERROR_CODES));
const KNOWN_MENACES = new Set(Object.values(MENACES));

/** Erreur typée du format chiffré : un code stable, les menaces couvertes, un contexte sérialisable. */
export class CryptoError extends Error {
  /**
   * @param {string} code une valeur de `CRYPTO_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {{ menaces?: string[], context?: Record<string, unknown> }} [details]
   */
  constructor(code, message, { menaces = [], context = {} } = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur cryptographique inconnu : ${code}`);
    }
    for (const menace of menaces) {
      if (!KNOWN_MENACES.has(menace)) {
        throw new Error(`Menace inconnue : ${menace}`);
      }
    }
    super(message);
    this.name = "CryptoError";
    this.code = code;
    this.menaces = Object.freeze([...menaces]);
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable : un refus de sécurité ne doit pas se perdre au passage du port. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      menaces: this.menaces,
      message: this.message,
      context: this.context,
    };
  }
}

/** Vrai si `valeur` est une erreur du format chiffré portant `code`. */
export function isCryptoError(valeur, code) {
  return valeur instanceof CryptoError && (code === undefined || valeur.code === code);
}

/** Entrée structurellement inadmissible : le modèle refuse plutôt que de compléter. */
export function malforme(raison, context = {}) {
  return new CryptoError(CRYPTO_ERROR_CODES.malformed, `Entrée refusée : ${raison}`, { context });
}

/**
 * L'étiquette ne vérifie pas. Le message DIT que la cause n'est pas établie : prétendre distinguer
 * un octet retourné d'un bloc déplacé serait un mensonge de diagnostic, et le dépôt en refuse le
 * principe depuis l'ADR 0014 (« tout doute est un refus », jamais une cause devinée).
 */
export function sceauRefuse(context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.sealRejected,
    "Sceau refusé : l'étiquette ne vérifie pas sous l'identité logique présentée. La cause n'est pas établie — un octet altéré et un bloc présenté à une autre adresse, dans un autre volume, sous un autre format ou une autre génération produisent le MÊME verdict. Aucun clair n'est rendu.",
    { menaces: [MENACES.modification, MENACES.deplacement], context },
  );
}

/**
 * Le sceau ne se DÉCRIT pas comme l'identité présentée : nonce qui n'encode pas la génération et le
 * rang annoncés, ou en-tête authentique qui nomme un autre volume, un autre format, une autre
 * taille. Établi sans le secours de l'étiquette dans le premier cas, après elle dans le second.
 *
 * Il couvre les deux mêmes menaces que `sceauRefuse`, et pour la même raison : un nonce qui a bougé
 * d'un octet et un bloc lu ailleurs sont indiscernables. Ce qu'il apporte est le CHAMP en désaccord,
 * pas une cause.
 */
export function identiteIncoherente(raison, context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.identityMismatch,
    `Sceau refusé : ${raison} Le sceau ne se décrit pas comme l'identité sous laquelle il est relu ; la cause — octet altéré ou bloc venu d'ailleurs — n'est pas établie. Aucun clair n'est rendu.`,
    { menaces: [MENACES.modification, MENACES.deplacement], context },
  );
}

/** Une génération ou une séquence authentifiée mais ANTÉRIEURE au minimum exigé. */
export function rejeu(context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.replay,
    "Sceau authentique mais ANTÉRIEUR au minimum exigé : c'est un rejeu. Le refus vaut ce que vaut le minimum présenté — l'ADR 0015 dit d'où il vient et ce qu'il ne couvre pas (retour arrière complet du support).",
    { menaces: [MENACES.rejeu], context },
  );
}

/** Le compte authentifié des entrées ne correspond pas à ce qui a été trouvé. */
export function troncature(context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.truncation,
    "Génération refusée : le nombre d'entrées ou la longueur de charge trouvés diffèrent de ce que la racine authentifie. Une génération incomplète n'est pas une génération plus courte.",
    { menaces: [MENACES.troncature], context },
  );
}

/** Le compte est juste, l'ensemble ne l'est pas : au moins une entrée vient d'ailleurs. */
export function melange(context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.mixing,
    "Génération refusée : le compte des entrées est juste mais leur empreinte ne l'est pas. Au moins une entrée, fût-elle authentique, n'appartient pas à cette génération ou n'est pas à sa place.",
    { menaces: [MENACES.melange], context },
  );
}

/**
 * Le nonce se répéterait sous la même clé. Refus AVANT de produire le moindre octet.
 *
 * Deux causes, toutes deux hors de portée d'un scellement isolé et donc vérifiées à l'échelle de la
 * génération : deux entrées de même rang, ou une séquence de racine qui ne croît pas strictement.
 */
export function nonceReutilise(raison, context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.nonceReuse,
    `Scellement refusé : ${raison} Le nonce se répéterait sous la même clé, ce qui livrerait le XOR des deux clairs ET la clé d'authentification GCM. Aucun octet n'est produit.`,
    { context },
  );
}

/** Le budget de scellements de la clé est atteint. Le remède est une clé, pas une tolérance. */
export function budgetDeCle(context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.keyBudget,
    "Scellement refusé : le budget de scellements de cette clé est atteint (NIST SP 800-38D, § 8.3). Poursuivre exigerait une clé de volume neuve ; continuer sous la même clé sortirait du domaine de validité de la primitive.",
    { context },
  );
}

/** Un algorithme que cette version de la spécification ne connaît pas. Jamais deviné. */
export function algorithmeInconnu(context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.algorithmUnsupported,
    "Algorithme refusé : cette version de la spécification n'en admet qu'un seul, et le nom présenté n'est pas le sien. Un second algorithme exigera une version de format et un ADR.",
    { context },
  );
}
