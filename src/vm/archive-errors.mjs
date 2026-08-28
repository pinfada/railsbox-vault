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
   * Le volume est CHIFFRÉ (format v3) et ce chemin ne sait pas porter son fichier tel quel (#18).
   *
   * Il n'est pas là pour dire « impossible » : l'ADR 0016 décide que l'archive porte le fichier v3
   * inchangé, et cette tranche ne l'a pas mis en œuvre. Ce qu'il empêche est précis — une archive
   * produite par le chemin de lecture AUTORISÉ, qui déchiffre, serait une archive EN CLAIR d'un
   * volume chiffré : le chiffrement au repos annulé dès que le fichier quitte l'appareil, sans que
   * rien ne le dise. Un refus est le seul état qui ne ment pas ici.
   */
  encryptedUnsupported: "VAULT_ARCHIVE_VOLUME_CHIFFRE",
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
