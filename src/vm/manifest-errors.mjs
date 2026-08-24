// Erreurs contractuelles du MANIFESTE de volume (#10, `VAULT-COMPAT-001`). Un format persistant ne
// doit jamais glisser vers un succès approximatif : un manifeste absent, malformé, futur ou
// incompatible produit une erreur TYPÉE à code stable, jamais un objet à moitié valide ni une
// écriture sur un volume non identifié.
//
// Ces codes forment une famille DISTINCTE de `storage-errors.mjs` (#4/#6), exactement comme le bail
// d'écriture (#8) porte sa propre `VAULT_LEASE_TRANSITION`. Le stockage décrit un état du support ;
// le manifeste décrit la compatibilité d'un format. Les fondre effacerait des remèdes différents —
// libérer de la place n'a rien à voir avec migrer un volume ou mettre à jour le runtime. Le module
// reprend en revanche la MÊME forme d'erreur (`code`, message français, contexte sérialisable,
// `toJSON`) pour rester transportable par `postMessage` comme les autres.

export const MANIFEST_ERROR_CODES = Object.freeze({
  /** Le manifeste lu n'est pas structurellement un manifeste v1 : jamais deviné, toujours refusé. */
  malformed: "VAULT_MANIFEST_MALFORMED",
  /** Version de format supérieure à ce que ce runtime connaît : refusée en lecture ET en écriture. */
  formatTooNew: "VAULT_MANIFEST_FORMAT_TOO_NEW",
  /** Version de format sous le plancher lisible de ce runtime : refusée. */
  formatTooOld: "VAULT_MANIFEST_FORMAT_TOO_OLD",
  /** Format lisible mais antérieur au format courant : écriture refusée jusqu'à migration (#13). */
  migrationRequired: "VAULT_MANIFEST_MIGRATION_REQUIRED",
  /** Volume écrit par un runtime majeur plus récent : écriture refusée (downgrade dangereux). */
  runtimeDowngrade: "VAULT_MANIFEST_RUNTIME_DOWNGRADE",
  /** L'application en cours ne correspond pas à celle qui possède le volume. */
  identityMismatch: "VAULT_MANIFEST_IDENTITY_MISMATCH",
  /** Ouverture en écriture d'un volume sans manifeste connu : jamais autorisée (`SEC-UPDATE-001`). */
  unidentified: "VAULT_MANIFEST_UNIDENTIFIED",
});

const KNOWN_CODES = new Set(Object.values(MANIFEST_ERROR_CODES));

/** Erreur typée du manifeste : un code stable, un message français, un contexte sérialisable. */
export class ManifestError extends Error {
  /**
   * @param {string} code une valeur de `MANIFEST_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code d'erreur de manifeste inconnu : ${code}`);
    }
    super(message);
    this.name = "ManifestError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur de manifeste portant `code` (ou n'importe lequel si omis). */
export function isManifestError(value, code) {
  return value instanceof ManifestError && (code === undefined || value.code === code);
}
