// Erreurs contractuelles de la RESTAURATION d'un volume (#12, `VAULT-PORT-001`). Restaurer, c'est
// écrire sur un support qui appartient à quelqu'un : le refus doit précéder la mutation, et il doit
// nommer ce qui manque. Un espace insuffisant, une cible déjà occupée, une géométrie incompatible et
// une re-vérification divergente n'ont pas le même remède — libérer de la place, consentir à
// l'écrasement, choisir une autre cible, réexporter la source —, donc pas le même code.
//
// Cette famille est DISTINCTE de celles du stockage (#4/#6), du bail (#8), du manifeste (#10) et de
// l'archive (#11), pour la même raison qu'elles sont distinctes entre elles. Elle ne les
// reconditionne pas : une archive invalide reste une `ArchiveError` de #11 et un manifeste
// incompatible une `ManifestError` de #10, propagées telles quelles par l'import. Elle en reprend
// en revanche la MÊME forme transportable (`code`, message français, contexte sérialisable,
// `toJSON`), pour franchir `postMessage` sans se perdre.

export const IMPORT_ERROR_CODES = Object.freeze({
  /** La cible porte déjà un volume : jamais écrasée sans consentement explicite de l'appelant. */
  targetNotEmpty: "VAULT_IMPORT_TARGET_NOT_EMPTY",
  /** L'espace estimé est inférieur au volume à restaurer : refusé AVANT toute mutation (#9). */
  spaceInsufficient: "VAULT_IMPORT_SPACE_INSUFFICIENT",
  /** La cible ouverte n'a pas la taille du volume de l'archive : jamais retaillée en silence. */
  geometryMismatch: "VAULT_IMPORT_GEOMETRY_MISMATCH",
  /** La relecture du volume restauré ne rend pas l'empreinte de l'archive : jamais déclaré valide. */
  verificationFailed: "VAULT_IMPORT_VERIFICATION_FAILED",
  /**
   * L'archive est ANTÉRIEURE à la version d'enveloppe que l'utilisateur tient sur sa feuille de
   * récupération, et aucun consentement nommé ne l'assume (#149, ADR 0027, décision 3).
   *
   * Une archive est par nature antérieure. La restaurer telle quelle est légitime — c'est même ce
   * qu'on attend d'une sauvegarde —, mais elle rétablit l'enveloppe telle qu'elle était : une clé
   * révoquée DEPUIS peut y être encore valable. Le refus n'interdit pas le geste, il exige qu'un
   * exploitant identifié dise qu'il l'accepte, exactement comme l'ADR 0011 le fait d'une migration
   * sans sauvegarde.
   */
  consentementRequis: "VAULT_IMPORT_CONSENTEMENT_REQUIS",
  // `encryptedUnsupported` (`VAULT_IMPORT_VOLUME_CHIFFRE`) a existé jusqu'au 6 septembre 2026 (#139),
  // retiré parce que jamais levé : la recopie brute qui lui manquait est livrée depuis (#101). L'ADR
  // 0016 décision 9 est devenue vraie ce jour-là. Nommé ici pour qu'un relecteur ne le cherche pas.
});

const KNOWN_CODES = new Set(Object.values(IMPORT_ERROR_CODES));

/** Erreur typée de la restauration : un code stable, un message français, un contexte sérialisable. */
export class ImportError extends Error {
  /**
   * @param {string} code une valeur de `IMPORT_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur de restauration inconnu : ${code}`);
    }
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur de restauration portant `code` (ou n'importe lequel si omis). */
export function isImportError(value, code) {
  return value instanceof ImportError && (code === undefined || value.code === code);
}
