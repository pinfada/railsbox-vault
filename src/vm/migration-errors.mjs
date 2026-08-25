// Erreurs contractuelles des MIGRATIONS DE FORMAT (#13, `VAULT-COMPAT-001`). Migrer, c'est décider
// d'un changement irréversible du point de vue du produit — le downgrade est refusé (ADR 0007). Un
// tel geste ne doit jamais glisser vers un succès approximatif : chaque refus porte un code stable
// et le remède qui lui correspond.
//
// Cette famille est DISTINCTE de celles du stockage (#4/#6), du bail (#8), du manifeste (#10), de
// l'archive (#11) et de la restauration (#12), pour la raison qui les sépare déjà entre elles : des
// remèdes différents. « Aucune étape enregistrée vers ce format » n'appelle pas la même conduite que
// « votre sauvegarde ne décrit pas ce volume ». Elle reprend en revanche la MÊME forme transportable
// (`code`, message français, contexte sérialisable, `toJSON`) pour traverser `postMessage` comme les
// autres.
//
// Les refus de compatibilité de #10 (`VAULT_MANIFEST_FORMAT_TOO_NEW`, `..._IDENTITY_MISMATCH`,
// `..._UNIDENTIFIED`) NE SONT PAS reconditionnés ici : ils remontent tels quels.

export const MIGRATION_ERROR_CODES = Object.freeze({
  /** Aucune étape enregistrée ne relie le format du volume au format demandé. */
  noPath: "VAULT_MIGRATION_NO_PATH",
  /** Le format demandé est ANTÉRIEUR à celui du volume : une migration ne descend jamais. */
  downgradeRefused: "VAULT_MIGRATION_DOWNGRADE_REFUSED",
  /** Ni sauvegarde vérifiée, ni consentement nommé : la migration n'est pas engagée. */
  backupRequired: "VAULT_MIGRATION_BACKUP_REQUIRED",
  /** L'archive présentée comme sauvegarde ne décrit pas ce volume dans son état courant. */
  backupMismatch: "VAULT_MIGRATION_BACKUP_MISMATCH",
  /**
   * Le journal de reprise existe mais ne fait pas AUTORITÉ : illisible, ou contredisant le
   * manifeste présent, ou visant un format que le volume ne porte pas. Jamais deviné, jamais
   * supprimé — un journal peut être le reliquat périmé d'un volume qui a été recréé depuis.
   */
  journalMalformed: "VAULT_MIGRATION_JOURNAL_MALFORMED",
  /** Le manifeste dont part la migration ne décrit pas la géométrie réelle du support. */
  geometryMismatch: "VAULT_MIGRATION_GEOMETRY_MISMATCH",
  /** Le manifeste relu depuis le support ne rend pas les octets inscrits : volume non identifié. */
  verificationFailed: "VAULT_MIGRATION_VERIFICATION_FAILED",
});

const KNOWN_CODES = new Set(Object.values(MIGRATION_ERROR_CODES));

/** Erreur typée d'une migration : un code stable, un message français, un contexte sérialisable. */
export class MigrationError extends Error {
  /**
   * @param {string} code une valeur de `MIGRATION_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur de migration inconnu : ${code}`);
    }
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur de migration portant `code` (ou n'importe lequel si omis). */
export function isMigrationError(value, code) {
  return value instanceof MigrationError && (code === undefined || value.code === code);
}
