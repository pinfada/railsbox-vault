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

/**
 * Les cinq menaces nommées par l'ADR 0015.
 *
 * **Tous les refus n'en citent pas.** Ceux qui répondent d'une menace la nomment — sceau refusé,
 * identité incohérente, rejeu, troncature, mélange. Les quatre autres — entrée malformée, nonce
 * réutilisé, budget de clé, algorithme inconnu — répondent d'une VIOLATION DE CONTRAT par
 * l'appelant, en amont de toute menace, et leur `menaces` est vide. Confondre les deux ferait croire
 * qu'un adversaire est à l'œuvre là où c'est une faute de programmation, et l'inverse.
 */
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
  /**
   * L'ordre canonique d'une génération est violé : rangs qui ne croissent pas strictement, ou
   * séquence de racine qui ne dépasse pas la précédente.
   *
   * **Ce code s'appelait `VAULT_CRYPTO_NONCE_REUTILISE`, et le renommer est une correction, pas un
   * ravalement.** Tant que le nonce était dérivé de (génération, rang), un rang répété RÉÉMETTAIT
   * un nonce : le nom disait vrai. Depuis que le nonce est tiré (ADR 0015), il ne le dit plus, et
   * le garder aurait fait affirmer au modèle une conséquence qu'il ne produit plus. Ce que ces
   * refus protègent désormais est réel mais différent : une racine scelle une SUITE ordonnée, et
   * deux racines de même séquence rendraient l'autorité ambiguë pour `#racineFaisantAutorite`.
   *
   * Le modèle, lui, ne sait PLUS détecter une réutilisation de nonce : il est sans état, et
   * l'unicité vient du tirage, pas d'un contrôle.
   */
  orderInvalid: "VAULT_CRYPTO_ORDRE_INVALIDE",
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
 * L'en-tête AUTHENTIFIÉ d'une racine ne décrit pas le volume que l'appelant croit ouvrir : autre
 * identifiant de volume, autre version de format, autre taille. Constaté APRÈS que l'étiquette a
 * vérifié, donc sur des valeurs authentiques — c'est un déplacement ÉTABLI, pas soupçonné.
 *
 * Depuis que le nonce est tiré au hasard (ADR 0015), il ne décrit plus rien : un nonce altéré ne se
 * distingue plus d'un chiffré altéré, et les deux tombent dans `sceauRefuse`. Ce constructeur ne
 * sert donc plus qu'à la racine, où l'en-tête en clair porte les champs à confronter.
 */
export function identiteIncoherente(raison, context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.identityMismatch,
    `Racine refusée : ${raison} L'en-tête est authentique — c'est donc bien une racine, mais pas celle de ce volume, de ce format ou de cette taille. Aucune génération n'est ouverte.`,
    { menaces: [MENACES.deplacement], context },
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
 * L'ordre canonique d'une génération est violé. Refus AVANT de produire le moindre octet.
 *
 * Deux causes, toutes deux hors de portée d'un scellement isolé et donc vérifiées à l'échelle de la
 * génération : des rangs qui ne croissent pas strictement, ou une séquence de racine qui ne dépasse
 * pas la précédente.
 */
export function ordreInvalide(raison, context = {}) {
  return new CryptoError(
    CRYPTO_ERROR_CODES.orderInvalid,
    `Scellement refusé : ${raison} Une racine scelle une SUITE ordonnée, et deux racines de même séquence rendraient l'autorité ambiguë à la reprise. Aucun octet n'est produit.`,
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
