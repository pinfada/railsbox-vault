// Erreurs contractuelles de la DÉRIVATION des clés de déverrouillage (#22, ADR 0021).
//
// Quatrième famille du dépôt, à côté de `storage-errors.mjs` (état du SUPPORT),
// `format-chiffre/crypto-errors.mjs` (propriété du FORMAT) et `enveloppe/enveloppe-errors.mjs`
// (état de l'ENVELOPPE). Elle existe pour la raison qui a séparé les trois autres, et pas une
// autre : **les remèdes n'ont rien de commun**.
//
//  - une phrase qui n'ouvre pas se répare en tapant l'autre phrase — et ce refus-là n'est PAS
//    d'ici : il vient de l'enveloppe (`VAULT_ENVELOPPE_CLE_REFUSEE`), parce qu'un dérivateur ne
//    sait pas, et ne peut pas savoir, qu'une phrase est fausse. Il dérive ce qu'on lui donne ;
//  - un moteur sans extension PRF se répare en créant un AUTRE emplacement, sur un autre moyen ;
//  - une annulation se répare en recommençant le geste ;
//  - un artefact Argon2 absent ou altéré se répare en réparant l'installation, jamais en dérivant
//    moins cher.
//
// ## Ce qu'aucun de ces codes ne fait
//
// Aucun ne dit qu'un secret est faux. Le dérivateur est une FONCTION : il rend une clé pour tout
// geste qu'il accepte, et c'est l'enveloppe qui tranche ensuite. Un code « mauvaise phrase » ici
// serait un oracle — il dirait à qui essaie des phrases laquelle mérite d'être essayée encore.

/** Ce qu'un refus de dérivation couvre. Même rôle que `SITUATIONS` de l'enveloppe. */
export const SITUATIONS = Object.freeze({
  /** Le moteur, l'authentificateur ou la plateforme n'offre pas l'extension demandée. */
  capaciteAbsente: "capacite-absente",
  /** L'utilisateur a refusé, fermé, ou laissé le temps s'écouler. */
  gesteInterrompu: "geste-interrompu",
  /** Les paramètres publics lus ne décrivent pas une dérivation admissible. */
  parametresInadmissibles: "parametres-inadmissibles",
  /** L'artefact de dérivation n'est pas celui que le dépôt a épinglé, ou n'est pas là. */
  artefactRefuse: "artefact-refuse",
  /** Le type de clé de déverrouillage lu n'est servi par aucun dérivateur de ce catalogue. */
  typeNonServi: "type-non-servi",
});

export const DERIVATION_ERROR_CODES = Object.freeze({
  /**
   * L'emplacement déclare un type de clé de déverrouillage que ce catalogue ne sert pas. Le
   * fichier n'est ni modifié, ni complété, ni deviné — point 5 du contrat de #22.
   */
  typeInconnu: "VAULT_DERIVATION_TYPE_INCONNU",
  /**
   * Les paramètres publics ne décrivent pas une dérivation admissible : structure, plafond de 512
   * octets (ADR 0020), ou coût SOUS le plancher de la RFC 9106. Ce dernier cas est le plus
   * important : des paramètres affaiblis par un adversaire ayant accès au fichier rendraient le
   * volume volé cassable à bas coût, et l'ADR 0020 les authentifie précisément pour cela.
   */
  parametresRefuses: "VAULT_DERIVATION_PARAMETRES_REFUSES",
  /**
   * Aucune phrase n'a été présentée. Ce n'est PAS « mauvaise phrase », qui n'existe pas ici : une
   * phrase absente n'est pas une phrase fausse, et l'une se répare en tapant quelque chose.
   */
  phraseRefusee: "VAULT_DERIVATION_PHRASE_REFUSEE",
  /**
   * L'artefact Argon2id vendu est absent, illisible, ou son empreinte n'est pas celle qu'épingle
   * `vendor/argon2/MANIFEST.json`. Aucun repli : dériver « autrement » serait dériver moins cher.
   */
  argon2Indisponible: "VAULT_DERIVATION_ARGON2_INDISPONIBLE",
  /**
   * (a) du contrat de #22 : le moteur n'a pas WebAuthn, ou l'extension `prf` n'est pas offerte à
   * l'ENREGISTREMENT (`prf` absent du résultat d'extensions, ou `enabled` faux). L'emplacement
   * n'est pas créé, et rien n'est dégradé en un autre moyen à l'insu de l'utilisateur.
   */
  prfIndisponible: "VAULT_DERIVATION_PRF_INDISPONIBLE",
  /**
   * (b) du contrat de #22 : la créance existe, l'extension a été DEMANDÉE à l'assertion, et sa
   * sortie n'est pas là. Code DISTINCT du précédent : ici l'emplacement est légitime et le remède
   * est un autre authentificateur, pas un autre moyen.
   */
  prfIgnoree: "VAULT_DERIVATION_PRF_IGNOREE",
  /**
   * (c) du contrat de #22 : `NotAllowedError` — annulation ou temps écoulé. Aucun repli
   * automatique n'est tenté, et aucun compteur d'échec n'est persisté : le dérivateur est sans
   * état, et deux annulations de suite sont exactement la première, répétée.
   */
  annulee: "VAULT_DERIVATION_ANNULEE",
});

const CODES_CONNUS = new Set(Object.values(DERIVATION_ERROR_CODES));
const SITUATIONS_CONNUES = new Set(Object.values(SITUATIONS));

/** Erreur typée de la dérivation : un code stable, les situations couvertes, un contexte. */
export class DerivationError extends Error {
  /**
   * @param {string} code une valeur de `DERIVATION_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {{ situations?: string[], context?: Record<string, unknown> }} [details]
   */
  constructor(code, message, { situations = [], context = {} } = {}) {
    if (!CODES_CONNUS.has(code)) throw new Error(`Code d'erreur de dérivation inconnu : ${code}`);
    for (const situation of situations) {
      if (!SITUATIONS_CONNUES.has(situation)) throw new Error(`Situation inconnue : ${situation}`);
    }
    super(message);
    this.name = "DerivationError";
    this.code = code;
    this.situations = Object.freeze([...situations]);
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable : un refus de sécurité ne doit pas se perdre au passage du port. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      situations: this.situations,
      message: this.message,
      context: this.context,
    };
  }
}

/** Vrai si `valeur` est une erreur de dérivation portant `code`. */
export function isDerivationError(valeur, code) {
  return valeur instanceof DerivationError && (code === undefined || valeur.code === code);
}

/** Le type de clé de déverrouillage de cet emplacement n'est servi par aucun dérivateur. */
export function typeInconnu(context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.typeInconnu,
    "Emplacement non pris en charge : son type de clé de déverrouillage n'est servi par aucun dérivateur de ce catalogue. Rien n'est deviné, rien n'est essayé, et le fichier d'enveloppes n'est pas modifié — un type inconnu vient d'une version plus récente ou d'un moyen qui n'est pas installé ici, jamais d'une clé fausse.",
    { situations: [SITUATIONS.typeNonServi], context },
  );
}

/** Les paramètres publics ne décrivent pas une dérivation admissible. */
export function parametresRefuses(raison, context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.parametresRefuses,
    `Paramètres de dérivation refusés : ${raison} Aucune clé n'est dérivée, et aucune valeur n'est complétée par défaut — un paramètre manquant n'est pas un paramètre nul.`,
    { situations: [SITUATIONS.parametresInadmissibles], context },
  );
}

/** Aucune phrase n'a été présentée. Ce n'est jamais « mauvaise phrase ». */
export function phraseRefusee(raison, context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.phraseRefusee,
    `Phrase de déverrouillage refusée : ${raison} Ce n'est PAS le refus d'une phrase fausse — un dérivateur ne sait pas qu'une phrase est fausse, il dérive ce qu'on lui donne et c'est l'enveloppe qui tranche.`,
    { context },
  );
}

/** L'artefact Argon2id vendu manque, ou n'est pas celui qui est épinglé. */
export function argon2Indisponible(raison, context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.argon2Indisponible,
    `Dérivation par phrase impossible : ${raison} Aucun repli n'est tenté. Dériver « autrement » voudrait dire dériver MOINS CHER, c'est-à-dire remettre à un adversaire un volume cassable, et ce serait un désastre silencieux plutôt qu'un refus visible.`,
    { situations: [SITUATIONS.artefactRefuse], context },
  );
}

/** WebAuthn ou l'extension `prf` manque à l'enregistrement. */
export function prfIndisponible(raison, context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.prfIndisponible,
    `Enregistrement d'une clé WebAuthn refusé : ${raison} Aucun autre moyen n'est mis en place à votre place — un emplacement créé sur un moyen que vous n'avez pas choisi serait une promesse fausse. Le second moyen se crée explicitement.`,
    { situations: [SITUATIONS.capaciteAbsente], context },
  );
}

/** L'extension `prf` a été demandée à l'assertion, et sa sortie n'est pas revenue. */
export function prfIgnoree(raison, context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.prfIgnoree,
    `Déverrouillage WebAuthn refusé : ${raison} L'emplacement est légitime — c'est l'authentificateur ou le moteur qui n'a pas rendu la sortie de l'extension. Aucun repli n'est tenté, et aucune clé approchante n'est fabriquée.`,
    { situations: [SITUATIONS.capaciteAbsente], context },
  );
}

/** L'utilisateur a annulé, ou le temps s'est écoulé. */
export function annulee(context = {}) {
  return new DerivationError(
    DERIVATION_ERROR_CODES.annulee,
    "Geste de déverrouillage annulé : l'authentificateur a rendu « NotAllowedError » — refus, fermeture, ou temps écoulé. Rien n'a été tenté ensuite : aucun repli automatique vers un autre moyen, et aucun compteur d'échec n'est conservé. Recommencer le geste est exactement recommencer, sans pénalité et sans trace.",
    { situations: [SITUATIONS.gesteInterrompu], context },
  );
}
