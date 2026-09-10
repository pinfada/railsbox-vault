// Erreurs contractuelles de l'ARCHIVE d'export (#11, `VAULT-PORT-001`). Une archive relue ne doit
// jamais glisser vers un succès approximatif : un en-tête méconnaissable, une archive tronquée ou une
// empreinte non concordante produit une erreur TYPÉE à code stable, jamais un « à peu près valide ».
//
// Ces codes forment une famille DISTINCTE de `storage-errors.mjs` (#4/#6), du bail (#8) et du
// manifeste (#10), exactement comme ces derniers sont distincts entre eux. Le stockage décrit un état
// du support ; le manifeste, la compatibilité d'un format ; l'archive, l'INTÉGRITÉ d'un conteneur
// portable. Les fondre effacerait des remèdes différents — une empreinte non concordante n'est pas
// une troncature, et ni l'une ni l'autre n'est un format futur. Le module reprend en revanche la
// MÊME forme d'erreur (`code`, message français, contexte sérialisable, `toJSON`) pour rester
// transportable par `postMessage` comme les autres. Un manifeste incompatible reste, lui, signalé
// par la `ManifestError` de #10, que la vérification propage sans la reconditionner.

export const ARCHIVE_ERROR_CODES = Object.freeze({
  /** L'entrée n'est pas structurellement une archive v1 : marqueur absent, en-tête illisible. */
  malformed: "VAULT_ARCHIVE_MALFORMED",
  /** L'archive est plus courte que ce que son en-tête déclare : octets manquants, jamais complétés. */
  truncated: "VAULT_ARCHIVE_TRUNCATED",
  /** L'empreinte recalculée du contenu diffère de celle inscrite : contenu altéré, jamais accepté. */
  digestMismatch: "VAULT_ARCHIVE_DIGEST_MISMATCH",
  /** La longueur du contenu contredit la géométrie du manifeste ou l'en-tête : archive incohérente. */
  geometryMismatch: "VAULT_ARCHIVE_GEOMETRY_MISMATCH",
  /**
   * L'empreinte recalculée de la SECTION DE RÉCUPÉRATION diffère de celle inscrite (#149, ADR 0027).
   *
   * Distinct de `digestMismatch` parce que le remède l'est : un contenu altéré rend l'archive
   * inutilisable, une enveloppe altérée rend le volume restauré INOUVRABLE ailleurs alors que ses
   * données sont intactes. Confondre les deux enverrait réexporter là où il faut d'abord savoir
   * lequel des deux on a perdu.
   */
  recuperationAlteree: "VAULT_ARCHIVE_RECUPERATION_ALTEREE",
  /**
   * La section de récupération n'est pas une page d'enveloppe de récupération SEULE : illisible, de
   * mauvaise taille, ou portant un emplacement d'un autre type que 4 (#149, ADR 0027).
   *
   * C'est la garde qui tient la propriété « le coffre et sa clé ne voyagent pas ensemble » sur une
   * archive que n'importe qui a pu écrire.
   */
  recuperationRefusee: "VAULT_ARCHIVE_RECUPERATION_REFUSEE",
  /**
   * L'archive porte une version que ce runtime ne LIT PAS (#181).
   *
   * Depuis #181, la seule version lue est la 3 : les archives v1 et v2 sont REFUSÉES parce
   * qu'elles ne portent aucun engagement, et c'est exactement le défaut que la revue externe a
   * relevé. Le code est distinct de `malformed`, qui dit « ce conteneur est méconnaissable » : ici
   * le conteneur est parfaitement reconnu, et c'est sa version qui est refusée. Confondre les deux
   * ferait chercher une corruption là où il n'y a qu'un format d'un autre âge.
   *
   * Il couvre aussi la version FUTURE, et l'ADR 0011 veut exactement cela : un refus explicite d'un
   * format qu'on ne sait pas lire, jamais une méconnaissance.
   */
  versionNonLue: "VAULT_ARCHIVE_VERSION_NON_LUE",
  /**
   * Une archive v3 ne DÉCLARE aucun engagement, ou en déclare un illisible (#181).
   *
   * L'engagement est ce qui rend une archive authentifiée ; une v3 qui n'en porte pas n'est pas une
   * v3, quoi que son en-tête annonce. Le refus tombe à la VÉRIFICATION, avant que la cible ne soit
   * même ouverte.
   */
  engagementAbsent: "VAULT_ARCHIVE_ENGAGEMENT_ABSENT",
  // `encryptedUnsupported` (`VAULT_ARCHIVE_VOLUME_CHIFFRE`) a existé jusqu'au 6 septembre 2026 (#139),
  // retiré parce que jamais levé : il tenait lieu de ce que l'ADR 0016 décision 7 livre depuis —
  // l'archive porte le fichier v3 tel quel. L'ADR 0016 décision 9 est devenue vraie ce jour-là. Nommé
  // ici pour qu'un relecteur ne le cherche pas.
});

const KNOWN_CODES = new Set(Object.values(ARCHIVE_ERROR_CODES));

/** Erreur typée de l'archive : un code stable, un message français, un contexte sérialisable. */
export class ArchiveError extends Error {
  /**
   * @param {string} code une valeur de `ARCHIVE_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur d'archive inconnu : ${code}`);
    }
    super(message);
    this.name = "ArchiveError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur d'archive portant `code` (ou n'importe lequel si omis). */
export function isArchiveError(value, code) {
  return value instanceof ArchiveError && (code === undefined || value.code === code);
}
