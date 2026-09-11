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
   * Une racine de génération est ABÎMÉE et rien ne dit ce qu'elle validait (#16 ; #144).
   *
   * Deux états le produisent, et le second a été ajouté par #144 :
   *
   *  - aucune racine LISIBLE alors qu'au moins une est abîmée. On ne sait pas ce qui a été validé ;
   *  - une racine abîmée à côté d'une racine RETENUE, sans témoin pour dire laquelle faisait
   *    autorité. L'alternance (§ 6.6) garde `s − 1` lisible : abîmer `s` fait reculer le volume
   *    d'une génération, et sans témoin rien ne distingue ce recul d'une validation déchirée.
   *
   * Dans les deux cas, écarter serait peut-être juste, et peut-être une perte d'écriture acquittée.
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
  /**
   * Le budget de scellements d'une clé à compteur est atteint (#18 ; NIST SP 800-38D § 8.3).
   *
   * Depuis le format v4, il y a DEUX clés à compteur par volume — celle du domaine `volume` et celle
   * du domaine `journal` — et donc deux budgets. Le code reste UN : le remède est le même des deux
   * côtés, et c'est le CONTEXTE qui dit quel domaine a atteint son plafond. Deux codes auraient
   * nommé deux situations là où il n'y a qu'une règle (ADR 0033, décision 4).
   */
  budgetDeCle: "VAULT_STORAGE_BUDGET_DE_CLE",
  /**
   * La session est ouverte en LECTURE SEULE et un scellement lui a été demandé (#182, ADR 0033).
   *
   * C'est la moitié exécutable de la règle de clôture : _toute session qui scelle sous une clé à
   * compteur clôt par une RACINE qui publie les deux compteurs ; une ouverture qui ne peut pas
   * écrire de racine n'a pas le droit de sceller._ Sans ce refus, les scellements d'une telle
   * session ne seraient publiés dans aucun compteur, et le budget de la clé serait de nouveau
   * sous-estimé — c'est-à-dire exactement le constat #182, qu'un budget avoué faux reste faux.
   *
   * Le remède n'est pas de réessayer : il est d'ouvrir le volume par un chemin qui sait dater, ou de
   * se contenter de lire.
   */
  lectureSeule: "VAULT_STORAGE_LECTURE_SEULE",
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
  /**
   * AUCUNE racine ne fait autorité, et rien n'autorise cette ouverture (#181).
   *
   * Depuis #181, **aucun volume légitime n'est sans racine** : la création en écrit une avant de
   * poser `VLTSEAL1`, la migration v2 → v3 aussi, et un volume RESTAURÉ en reçoit une à sa première
   * ouverture, sur présentation de l'engagement que l'archive portait. Un volume sans racine est
   * donc soit un volume créé avant cette tranche, soit un volume restauré dont on a retiré le
   * voisin `<volume>.engagement` — c'est-à-dire, dans le second cas, exactement le geste par lequel
   * un adversaire faisait passer un mélange de secteurs pour un volume neuf.
   *
   * Le refus tombe AVANT tout clair : aucun secteur n'est déchiffré, et l'ouverture ne rend aucun
   * backend. Distinct de `generationRootCorrupt`, qui dit « une racine existe et elle est abîmée ».
   */
  volumeSansRacine: "VAULT_STORAGE_VOLUME_SANS_RACINE",
  /**
   * Un ENGAGEMENT D'ARCHIVE est présent et il n'autorise pas cette ouverture (#181).
   *
   * Une seule cause est rendue, et c'est délibéré : étiquette forgée, sel modifié, descripteur
   * contredit, empreinte du fichier qui ne concorde pas, volume ou géométrie qui ne sont pas ceux
   * que l'engagement scelle — tout cela dit « cet engagement ne vaut pas pour ce fichier-ci », et
   * les distinguer donnerait à un adversaire un oracle sur ce qu'il a manqué.
   *
   * Distinct de `volumeSansRacine`, et le remède l'est aussi : là, il n'y avait rien à présenter ;
   * ici, ce qui est présenté ne tient pas — l'archive ou le volume restauré a été altéré.
   */
  engagementInvalide: "VAULT_STORAGE_ENGAGEMENT_INVALIDE",
  /**
   * Une CRÉATION versée hors transaction ne CONFIRME pas ce qu'elle a écrit (#181).
   *
   * Le versement d'un disque applicatif a lieu hors transaction, et la datation qui le suit ouvre le
   * fichier une seconde fois : entre les deux, personne ne tient ce fichier. Le versement rend donc
   * l'empreinte du fichier qu'il vient d'écrire — prise sous SA propre exclusivité —, et la datation
   * la confronte à ce qu'elle trouve AVANT d'écrire la racine initiale.
   *
   * Ce refus tombe dans les deux cas où la confrontation n'a pas lieu d'être crue : le versement n'a
   * rendu aucune empreinte — un appelant d'avant cette garde —, ou le fichier trouvé n'est pas celui
   * qu'il a écrit. Distinct de `engagementInvalide`, qui juge un engagement d'ARCHIVE présenté par
   * une restauration : ici il n'y a aucune archive, et le remède est de réinstaller, pas de restaurer.
   */
  creationNonConfirmee: "VAULT_STORAGE_CREATION_NON_CONFIRMEE",
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

/**
 * AUCUNE racine, et rien qui autorise l'ouverture (#181).
 *
 * Le message nomme les DEUX états qui y mènent, parce que leurs remèdes n'ont rien de commun : un
 * volume créé avant cette tranche n'a jamais eu de racine initiale et se recrée depuis une archive ;
 * un volume restauré dont le voisin `<volume>.engagement` a disparu a perdu ce qui prouvait que ses
 * octets sont un état réellement produit, et se restaure de nouveau depuis l'archive.
 */
export function volumeSansRacine(volume, { chargePresente }) {
  return new StorageError(
    STORAGE_ERROR_CODES.volumeSansRacine,
    `Volume « ${volume} » refusé : aucune racine de génération ne fait autorité, et rien n'autorise à en écrire une. Depuis #181, un volume légitime porte toujours une racine — sa création en écrit une, sa migration aussi, et une restauration en fait écrire une à la première ouverture sur présentation de l'engagement que l'archive portait. Ce volume est donc soit antérieur à cette règle, soit un volume restauré dont le voisin « .engagement » a disparu. Le remède est de le restaurer depuis son archive. Aucun octet n'est lu.`,
    { volume, chargePresente },
  );
}

/**
 * Une CRÉATION versée hors transaction ne CONFIRME pas ce qu'elle a écrit (#181).
 *
 * Le message nomme la FENÊTRE, parce que c'est elle qu'il faut comprendre : le versement ferme le
 * fichier, la datation le rouvre, et l'intervalle n'appartient à personne. Ce que la datation bénit
 * n'est donc légitime que si le fichier trouvé est encore celui que le versement a écrit — et c'est
 * l'empreinte, rendue par le versement, qui le dit.
 */
export function creationNonConfirmee(volume, detail) {
  return new StorageError(
    STORAGE_ERROR_CODES.creationNonConfirmee,
    `Volume « ${volume} » refusé : la datation de sa création ne peut pas confirmer ce qui a été versé — ${detail} Le versement écrit le fichier hors transaction puis le relâche ; la datation le rouvre, et l'empreinte que le versement a rendue est ce qui relie les deux gestes. Sans elle, dater bénirait des octets que ce produit n'a peut-être pas écrits. L'installation n'est PAS déclarée réussie ; le remède est de la recommencer. Aucun octet n'est lu.`,
    { volume },
  );
}

/**
 * Une racine ABÎMÉE à côté d'une racine RETENUE, et AUCUN témoin pour dire laquelle faisait
 * autorité (#144).
 *
 * Ce refus est le second état du même code, et le message doit dire pourquoi il n'est pas le
 * précédent : ici une racine survit, et l'ouverture pourrait continuer. Ce qui l'en empêche est
 * l'AMBIGUÏTÉ, et elle est réelle — l'alternance du § 6.6 garde `s − 1` lisible sur le support,
 * si bien qu'abîmer les 512 octets de `s` suffit à faire reculer le volume d'une génération, sans
 * clé et sans copie antérieure. Le témoin est ce qui trancherait ; son absence est justement ce que
 * l'adversaire doit obtenir, et le § 6.9 dit que cela ne lui coûte rien.
 *
 * Les DEUX lectures sont nommées, parce que rien ici ne les distingue et qu'un message qui n'en
 * nommerait qu'une enseignerait la mauvaise conduite dans l'autre moitié des cas.
 *
 * **Et une racine illisible n'a plus de SÉQUENCE lisible** : le message ne dit donc pas laquelle
 * des deux a été abîmée, parce que rien ne le sait. Prétendre la situer reviendrait à croire un
 * en-tête que rien n'authentifie. Relevé en revue : le refus tombe aussi quand c'est la racine
 * ANCIENNE qui a été abîmée — une avarie sans conséquence —, et c'est le prix de la règle.
 */
export function racineAbimeeSansTemoin(volume, { abimees, sequenceRetenue }) {
  return new StorageError(
    STORAGE_ERROR_CODES.generationRootCorrupt,
    `Journal de génération du volume « ${volume} » refusé : ${abimees} racine(s) abîmée(s) à côté de la racine de séquence ${sequenceRetenue}, qui reste lisible, et AUCUN témoin ne dit laquelle faisait autorité. Une racine illisible n'a plus de séquence lisible : elle portait ${sequenceRetenue - 1} — une avarie sans conséquence, typiquement une coupure pendant sa propre écriture — ou ${sequenceRetenue + 1}, et le volume a alors RECULÉ d'une génération. Rien ici ne dit laquelle, et continuer sur la racine lisible perdrait peut-être une écriture acquittée. Le volume n'est pas modifié ; restaurer une sauvegarde (#12) est le remède.`,
    { volume, abimees, sequenceRetenue },
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
