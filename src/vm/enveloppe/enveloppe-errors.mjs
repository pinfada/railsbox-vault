// Erreurs contractuelles de l'enveloppe de clé (#21, ADR 0020).
//
// Troisième famille du dépôt, à côté de `storage-errors.mjs` (état du SUPPORT) et de
// `format-chiffre/crypto-errors.mjs` (propriété du FORMAT CHIFFRÉ). Elle existe pour la raison que
// l'ADR 0007 a déjà tranchée entre stockage et manifeste, et que l'ADR 0015 a reprise entre stockage
// et format : les remèdes n'ont rien de commun. Un volume sans enveloppe se répare en recréant
// l'enveloppe ; une enveloppe dont la racine est refusée se répare en restaurant une sauvegarde ;
// une clé qui n'ouvre rien se répare en présentant une autre clé. Fondre les trois familles ferait
// disparaître ces trois remèdes derrière un code unique.
//
// ## Ce qui est ÉTABLI et ce qui ne l'est pas
//
// La discipline est celle de l'ADR 0015, mot pour mot : un verdict n'est posé qu'une fois qu'on a le
// DROIT de le poser. La racine du fichier est d'abord AUTHENTIFIÉE — étiquette vérifiée sur son
// en-tête —, et seulement ensuite l'identité, le compte et l'ordre des emplacements sont confrontés.
// `IDENTITE`, `TRONCATURE`, `MELANGE` et `REJEU` sont donc des constats sur des valeurs authentiques,
// jamais des devinettes sur des octets que rien ne garantit.
//
// ## Le refus de clé est UN, et c'est délibéré
//
// `CLE_REFUSEE` couvre DEUX situations que le format ne sait pas — et ne doit pas — distinguer : la
// clé présentée n'a jamais eu d'emplacement, ou l'emplacement qu'elle ouvrait a été révoqué. Une
// révocation RETIRE l'emplacement du fichier : il ne reste donc rien qui puisse dire « celle-ci fut
// valable ». Publier deux codes obligerait à conserver une trace des clés révoquées, c'est-à-dire à
// répondre « oui, cette clé a existé » à qui la présente — un oracle offert à quiconque essaie des
// clés. Le message le dit, et l'ADR 0020 nomme ce qui est mesuré (le nombre de tentatives AEAD,
// identique dans les deux cas) et ce qui ne l'est pas (le temps interne de WebCrypto).

/**
 * Ce qu'un refus de l'enveloppe couvre. Même rôle que `MENACES` du format chiffré : porter la LISTE
 * des situations qu'un code recouvre, jamais un diagnostic inventé.
 */
export const SITUATIONS = Object.freeze({
  /** Aucun emplacement de ce fichier ne s'ouvre sous la clé présentée. */
  cleInconnue: "cle-inconnue",
  /** L'emplacement qu'ouvrait cette clé a été retiré du fichier. Indiscernable du précédent. */
  emplacementRevoque: "emplacement-revoque",
  /** Les octets de la liste ne sont plus ceux que la racine authentifie. */
  modification: "modification",
  /** Le fichier — ou un emplacement — vient d'un autre volume. */
  deplacement: "deplacement",
  /** Une version antérieure du fichier a été remise en place. */
  rejeu: "rejeu",
  /** Il manque des emplacements par rapport à ce que la racine authentifie. */
  troncature: "troncature",
  /** Le compte est juste, l'ordre ou le contenu ne l'est pas. */
  melange: "melange",
});

export const ENVELOPPE_ERROR_CODES = Object.freeze({
  /**
   * Il n'y a PAS d'enveloppe pour ce volume. Distinct de tout refus de clé, et c'est le point 5 du
   * contrat de #21 : dire « clé invalide » à qui n'a jamais eu d'enveloppe envoie chercher une clé
   * qui n'existe pas, au lieu d'en créer une.
   */
  absente: "VAULT_ENVELOPPE_ABSENTE",
  /**
   * Un fichier d'enveloppes existe et AUCUNE de ses deux pages n'est exploitable. Distinct de
   * `ABSENTE` : ici quelque chose a été écrit, puis perdu ou abîmé, et le remède est une sauvegarde
   * — pas une création.
   */
  illisible: "VAULT_ENVELOPPE_ILLISIBLE",
  /**
   * Aucun emplacement ne s'ouvre sous la clé présentée. Couvre `cleInconnue` ET
   * `emplacementRevoque`, qui sont indiscernables par construction (voir l'en-tête de ce fichier).
   */
  cleRefusee: "VAULT_ENVELOPPE_CLE_REFUSEE",
  /**
   * L'étiquette de la racine ne vérifie pas sous l'en-tête présenté. Couvre modification et
   * déplacement, qui ne se distinguent pas — c'est la même réserve que `VAULT_CRYPTO_SCEAU_REFUSE`.
   */
  racineRefusee: "VAULT_ENVELOPPE_RACINE_REFUSEE",
  /** La racine AUTHENTIFIÉE décrit un autre volume. Constat établi, pas soupçonné. */
  identite: "VAULT_ENVELOPPE_IDENTITE",
  /** Moins d'emplacements que la racine authentifiée n'en compte. */
  troncature: "VAULT_ENVELOPPE_TRONCATURE",
  /** Le compte est juste, l'empreinte de la suite ordonnée ne l'est pas. */
  melange: "VAULT_ENVELOPPE_MELANGE",
  /** Version authentifiée mais ANTÉRIEURE au minimum exigé par l'appelant. */
  rejeu: "VAULT_ENVELOPPE_REJEU",
  /** Structure inadmissible : marqueur, version, largeur, longueur. Jamais complétée ni arrondie. */
  malforme: "VAULT_ENVELOPPE_MALFORME",
  /**
   * Révoquer le DERNIER emplacement est refusé : un volume sans issue n'est pas un état acceptable.
   * La récupération — et donc la seule façon de sortir d'un volume dont toutes les clés sont
   * perdues — est l'objet de #23.
   */
  dernierEmplacement: "VAULT_ENVELOPPE_DERNIER_EMPLACEMENT",
  /** Le fichier porte déjà le nombre maximal d'emplacements. Refusé avant d'écrire. */
  pleine: "VAULT_ENVELOPPE_PLEINE",
  /** L'emplacement visé par un remplacement ou une révocation n'existe pas. */
  emplacementInconnu: "VAULT_ENVELOPPE_EMPLACEMENT_INCONNU",
});

const CODES_CONNUS = new Set(Object.values(ENVELOPPE_ERROR_CODES));
const SITUATIONS_CONNUES = new Set(Object.values(SITUATIONS));

/** Erreur typée de l'enveloppe : un code stable, les situations couvertes, un contexte transportable. */
export class EnveloppeError extends Error {
  /**
   * @param {string} code une valeur de `ENVELOPPE_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {{ situations?: string[], context?: Record<string, unknown> }} [details]
   */
  constructor(code, message, { situations = [], context = {} } = {}) {
    if (!CODES_CONNUS.has(code)) {
      throw new Error(`Code d'erreur d'enveloppe inconnu : ${code}`);
    }
    for (const situation of situations) {
      if (!SITUATIONS_CONNUES.has(situation)) {
        throw new Error(`Situation inconnue : ${situation}`);
      }
    }
    super(message);
    this.name = "EnveloppeError";
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

/** Vrai si `valeur` est une erreur d'enveloppe portant `code`. */
export function isEnveloppeError(valeur, code) {
  return valeur instanceof EnveloppeError && (code === undefined || valeur.code === code);
}

/** Aucun fichier d'enveloppes n'existe pour ce volume. Ce n'est pas un refus de clé. */
export function enveloppeAbsente(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.absente,
    "Aucune enveloppe de clé pour ce volume : il n'y a rien à déverrouiller. Ce n'est PAS une clé invalide — un volume dont l'enveloppe manque ne s'ouvre par aucune clé, et le remède est d'en créer une (ou de restaurer la sauvegarde qui la porte), jamais d'en essayer une autre.",
    { context },
  );
}

/** Un fichier existe, aucune de ses deux pages n'est exploitable. */
export function enveloppeIllisible(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.illisible,
    "Enveloppe de clé refusée : le fichier existe mais aucune de ses deux pages ne se relit. Une coupure ne peut abîmer que la page en cours d'écriture ; les deux abîmées décrivent une perte, pas une interruption. Aucune clé n'est essayée.",
    { situations: [SITUATIONS.modification], context },
  );
}

/**
 * Aucun emplacement ne s'ouvre. Le message NOMME les deux situations sans prétendre les départager :
 * c'est ce qui rend une clé révoquée et une clé inconnue indiscernables.
 */
export function cleRefusee(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.cleRefusee,
    "Clé de déverrouillage refusée : aucun emplacement de cette enveloppe ne s'ouvre sous elle. La cause n'est pas établie, et elle ne peut pas l'être — cette clé n'a jamais eu d'emplacement, ou l'emplacement qu'elle ouvrait a été révoqué, et une révocation RETIRE l'emplacement. Aucune clé de volume n'est rendue.",
    { situations: [SITUATIONS.cleInconnue, SITUATIONS.emplacementRevoque], context },
  );
}

/** L'étiquette de la racine ne vérifie pas. Même réserve que `sceauRefuse` du format chiffré. */
export function racineRefusee(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.racineRefusee,
    "Racine d'enveloppe refusée : l'étiquette ne vérifie pas sous l'en-tête présenté. La cause n'est pas établie — un octet altéré, un en-tête réécrit, une page venue d'un autre fichier produisent le MÊME verdict. Aucune clé de volume n'est rendue.",
    { situations: [SITUATIONS.modification, SITUATIONS.deplacement], context },
  );
}

/** La racine AUTHENTIFIÉE nomme un autre volume : le déplacement est établi, pas soupçonné. */
export function identiteIncoherente(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.identite,
    "Enveloppe refusée : sa racine est authentique, mais elle décrit un AUTRE volume. C'est donc bien une enveloppe — pas celle de ce volume. Aucune clé de volume n'est rendue, et la vérification s'arrête ici.",
    { situations: [SITUATIONS.deplacement], context },
  );
}

/** Moins d'emplacements que la racine authentifiée n'en compte. */
export function troncature(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.troncature,
    "Enveloppe refusée : le nombre d'emplacements trouvés diffère de ce que la racine authentifie. Une enveloppe amputée n'est pas une enveloppe plus courte — l'emplacement manquant est peut-être le seul qui ouvrait encore.",
    { situations: [SITUATIONS.troncature], context },
  );
}

/** Le compte est juste, l'ensemble ordonné ne l'est pas. */
export function melange(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.melange,
    "Enveloppe refusée : le compte des emplacements est juste, leur empreinte ne l'est pas. Au moins un emplacement, fût-il authentique, n'appartient pas à cette enveloppe ou n'est pas à sa place.",
    { situations: [SITUATIONS.melange], context },
  );
}

/** Version authentifiée mais antérieure au minimum exigé. */
export function rejeu(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.rejeu,
    "Enveloppe refusée : sa version est authentique mais ANTÉRIEURE au minimum exigé. C'est un rejeu. Le refus vaut ce que vaut le minimum présenté — l'ADR 0020 dit d'où il peut venir, et qu'aucun ancrage monotone hors du fichier n'existe avant #23.",
    { situations: [SITUATIONS.rejeu], context },
  );
}

/** Structure inadmissible. Le format refuse plutôt que de compléter. */
export function malforme(raison, context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.malforme,
    `Enveloppe refusée : ${raison} Aucun octet n'est interprété au-delà de ce constat.`,
    { context },
  );
}

/** Révoquer le dernier emplacement laisserait un volume sans issue. */
export function dernierEmplacement(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.dernierEmplacement,
    "Révocation refusée : c'est le DERNIER emplacement de cette enveloppe. Un volume sans issue n'est pas un état acceptable — la révoquer rendrait les données irrécupérables sans aucun geste d'erreur supplémentaire. Ajoutez une autre clé d'abord ; la récupération est l'objet de #23.",
    { context },
  );
}

/** L'enveloppe porte déjà le nombre maximal d'emplacements. */
export function enveloppePleine(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.pleine,
    "Ajout refusé : cette enveloppe porte déjà le nombre maximal d'emplacements. Le plafond est un choix de format, justifié dans l'ADR 0020 ; le franchir demanderait une version de format, pas une tolérance.",
    { context },
  );
}

/** L'emplacement visé n'existe pas dans cette enveloppe. */
export function emplacementInconnu(context = {}) {
  return new EnveloppeError(
    ENVELOPPE_ERROR_CODES.emplacementInconnu,
    "Geste refusé : l'emplacement visé n'existe pas dans cette enveloppe. Il a peut-être déjà été révoqué. Rien n'est écrit, et aucun emplacement n'est créé pour l'occasion.",
    { context },
  );
}
