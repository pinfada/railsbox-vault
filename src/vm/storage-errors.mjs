// Erreurs contractuelles du backend de blocs. `docs/architecture.md` exige que quota, handle perdu,
// écriture partielle et échec de flush restent des états DISTINCTS : aucun d'eux ne doit se
// dégrader en succès, en bloc de zéros ou en réinitialisation silencieuse. Le spike #4 a proposé
// les huit premiers codes ; l'issue #6 les fige pour le backend OPFS de production et en ajoute
// trois que seul un support réel peut produire.

export const STORAGE_ERROR_CODES = Object.freeze({
  /** Lecture ou écriture hors de la géométrie déclarée. */
  outOfRange: "VAULT_STORAGE_OUT_OF_RANGE",
  /** Le support a rendu moins d'octets que demandé. */
  shortRead: "VAULT_STORAGE_SHORT_READ",
  /** Le support a accepté moins d'octets que demandé. */
  partialWrite: "VAULT_STORAGE_PARTIAL_WRITE",
  /** La barrière de durabilité n'a pas abouti. */
  flushFailed: "VAULT_STORAGE_FLUSH_FAILED",
  /** Le handle exclusif a disparu sous le volume ouvert. */
  handleLost: "VAULT_STORAGE_HANDLE_LOST",
  /** Opération demandée après fermeture du volume. */
  closed: "VAULT_STORAGE_CLOSED",
  /** Un autre détenteur possède déjà l'exclusivité du volume. */
  busy: "VAULT_STORAGE_BUSY",
  /** Capacité absente : jamais remplacée par un repli silencieux. */
  unsupported: "VAULT_STORAGE_UNSUPPORTED",
  /** Le quota de stockage de l'origine est épuisé (#6). Distinct d'une écriture partielle. */
  quotaExceeded: "VAULT_STORAGE_QUOTA_EXCEEDED",
  /** La géométrie du support diffère de celle de la session (#6). Jamais suivie en silence. */
  geometryMismatch: "VAULT_STORAGE_GEOMETRY_MISMATCH",
  /** Échec du support non classable dans les codes ci-dessus (#6). Jamais deviné, toujours nommé. */
  supportFailure: "VAULT_STORAGE_SUPPORT_FAILURE",
  /**
   * Une génération déposée sans validation a été ÉCARTÉE à l'ouverture (#16). Ce n'est pas une
   * panne : c'est le résultat normal d'une coupure, et le volume porte la génération validée
   * précédente. Le code existe pour que la mise au rebut soit NOMMÉE plutôt que silencieuse.
   */
  generationDiscarded: "VAULT_STORAGE_GENERATION_DISCARDED",
  /**
   * Une génération VALIDÉE dont la charge ne concorde plus (#16). Elle est refusée : la rejouer à
   * moitié écrirait un état que personne ne sait cohérent, et l'ignorer perdrait une écriture
   * acquittée. Aucune réparation par devinette.
   */
  generationCorrupt: "VAULT_STORAGE_GENERATION_CORRUPT",
  /** La génération en cours dépasse le plafond du journal (#16). Refusé tôt, jamais à moitié. */
  generationOverflow: "VAULT_STORAGE_GENERATION_OVERFLOW",
  /** Un geste exigeant une génération validée a été demandé sur une génération en cours (#16). */
  generationPending: "VAULT_STORAGE_GENERATION_PENDING",
  /**
   * Aucune racine de génération LISIBLE, alors qu'au moins une est abîmée (#16). On ne sait pas ce
   * qui a été validé : écarter serait peut-être juste, et peut-être une perte d'écriture acquittée.
   * Le refus est le seul état qui ne ment pas.
   */
  generationRootCorrupt: "VAULT_STORAGE_GENERATION_ROOT_CORRUPT",
  /**
   * Le sceau d'un secteur, d'un enregistrement ou d'une racine ne vérifie pas (#18, ADR 0016).
   *
   * C'est la traduction de `VAULT_CRYPTO_SCEAU_REFUSE`, et il porte la même réserve : la cause
   * n'est PAS établie. Un octet altéré, un secteur présenté à une autre adresse, dans un autre
   * volume, sous un autre format ou une autre génération produisent le même verdict — ils sont
   * cryptographiquement indiscernables. Aucun clair n'est rendu, et surtout aucun zéro.
   */
  sceauRefuse: "VAULT_STORAGE_SCEAU_REFUSE",
  /**
   * L'identité de volume PRÉSENTÉE ne correspond pas à celle qui est authentifiée (#18). Distinct du
   * précédent : ici l'en-tête a vérifié, donc l'écart est ÉTABLI, pas soupçonné.
   */
  identiteVolume: "VAULT_STORAGE_IDENTITE_VOLUME",
  /** Le budget de scellements de la clé de volume est atteint (#18 ; NIST SP 800-38D § 8.3). */
  budgetDeCle: "VAULT_STORAGE_BUDGET_DE_CLE",
  /**
   * Un volume au format v3 a été présenté SANS clé de volume (#18, ADR 0016). Rien n'est lu, rien
   * n'est deviné, aucune clé n'est fabriquée : le produit n'en fabrique aucune avant #21.
   */
  cleRequise: "VAULT_STORAGE_CLE_REQUISE",
  /**
   * La CRÉATION d'un volume v3 n'est pas allée jusqu'au bout (#18, ADR 0016).
   *
   * Distinct de `sceauRefuse`, et le remède n'est pas le même : un sceau refusé peut être une
   * altération d'un volume qui a servi, et le remède est alors une sauvegarde. Ici, le fichier n'a
   * jamais fini de naître — il n'a jamais porté de données —, et le remède est de le recréer.
   * Confondre les deux envoyait l'exploitant restaurer une sauvegarde d'un volume qui n'a jamais
   * existé.
   */
  volumeIncomplet: "VAULT_STORAGE_VOLUME_INCOMPLET",
  /**
   * L'adaptateur est QUIESCÉ : une capture d'instantané est en cours (#65, ADR 0024, décision 5).
   *
   * Ce code couvre les deux faces du même état, et c'est délibéré : le refus d'ÉTABLIR la
   * quiescence — E/S en vol, adaptateur déjà en panne — et le refus d'une E/S PENDANT la
   * quiescence. Les séparer aurait donné deux codes pour une seule invariance, « on ne capture pas
   * au-dessus d'une E/S », et c'est le contexte qui dit de quel côté on se trouve.
   */
  quiesce: "VAULT_STORAGE_QUIESCE",
});

const KNOWN_CODES = new Set(Object.values(STORAGE_ERROR_CODES));

/** Erreur typée du stockage : un code stable, un message français, un contexte sérialisable. */
export class StorageError extends Error {
  /**
   * @param {string} code une valeur de `STORAGE_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur de stockage inconnu : ${code}`);
    }
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur de stockage portant `code`. */
export function isStorageError(value, code) {
  return value instanceof StorageError && (code === undefined || value.code === code);
}

export function outOfRange(offset, length, size) {
  return new StorageError(
    STORAGE_ERROR_CODES.outOfRange,
    `Accès hors bornes : ${length} octet(s) à l'offset ${offset} d'un volume de ${size} octets.`,
    { offset, length, size },
  );
}

/**
 * Une génération validée dont la charge ne tient plus. Le message porte la raison exacte, parce que
 * « corruption » sans le POURQUOI n'apprend rien à qui doit décider s'il restaure une sauvegarde.
 */
export function generationCorrupt(volume, { generation, reason }) {
  return new StorageError(
    STORAGE_ERROR_CODES.generationCorrupt,
    `Génération ${generation} du volume « ${volume} » refusée : ${reason} Le volume n'est pas modifié ; restaurer une sauvegarde (#12) est le seul remède, deviner n'en est pas un.`,
    { volume, generation, reason },
  );
}

/**
 * Les racines du journal sont illisibles. Distinct de `GENERATION_CORRUPT`, qui décrit une charge
 * scellée devenue incohérente : ici c'est le SCEAU lui-même qu'on ne sait plus lire, et donc
 * l'existence même d'une génération validée qui est inconnue.
 */
export function generationRootCorrupt(volume, { abimees, octets }) {
  return new StorageError(
    STORAGE_ERROR_CODES.generationRootCorrupt,
    `Journal de génération du volume « ${volume} » refusé : ${abimees} racine(s) abîmée(s) et aucune lisible, au-dessus de ${octets} octet(s) de charge. Ce qui a été validé est INCONNU — l'écarter perdrait peut-être une écriture acquittée. Le volume n'est pas modifié ; restaurer une sauvegarde (#12) est le remède.`,
    { volume, abimees, octets },
  );
}

/** La génération en cours dépasserait le plafond du journal : refusée avant d'écrire quoi que ce soit. */
export function generationOverflow(volume, { pending, requested, limit }) {
  return new StorageError(
    STORAGE_ERROR_CODES.generationOverflow,
    `Génération du volume « ${volume} » trop grande : ${pending} octet(s) déjà déposés, ${requested} de plus demandés, plafond de ${limit}. Le guest doit franchir une barrière pour valider ce qui est en cours.`,
    { volume, pending, requested, limit },
  );
}

/**
 * La géométrie observée sur le support n'est pas celle de la session. Le backend refuse plutôt que
 * d'adopter la nouvelle taille : un volume qui rétrécit sous la VM n'est pas un volume plus petit,
 * c'est un volume corrompu.
 */
export function geometryMismatch(volume, { observed, expected, reason }) {
  return new StorageError(
    STORAGE_ERROR_CODES.geometryMismatch,
    `Géométrie du volume « ${volume} » incohérente : ${observed} octet(s) observés, ${expected ?? "aucune taille"} attendu(s). ${reason}`,
    { volume, observed, expected: expected ?? null, reason },
  );
}
