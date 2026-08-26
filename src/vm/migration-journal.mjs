// JOURNAL DE REPRISE d'une migration de format (#13, `VAULT-COMPAT-001`). La décision est
// l'ADR 0011.
//
// Le journal est le voisin `<volume>.migration` qu'une migration inscrit AVANT de révoquer le
// manifeste (geste 6) et retire en DERNIER geste. Il porte le manifeste SOURCE, la chaîne visée et
// la preuve retenue : sans lui, une interruption effacerait la seule trace de ce qu'était le volume
// et la reprise serait impossible — une interruption deviendrait une impasse.
//
// Ce module tient le FORMAT du journal, et rien d'autre : marqueur, version, sérialisation
// déterministe, analyse stricte. Ce qu'il n'arbitre PAS : si un journal fait autorité sur le volume
// à côté duquel il traîne. Rien ne garantit qu'un journal trouvé près d'un volume décrive CE volume ;
// c'est `volume-migration.mjs` qui le confronte au manifeste présent et à la géométrie du support.

import { EVIDENCE_KINDS } from "./migration-backup-proof.mjs";
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { MIGRATION_JOURNAL_SUFFIX, migrationJournalName } from "./opfs-sync-access.mjs";
import { parseManifest } from "./volume-manifest.mjs";

/** Marqueur du journal de reprise : il n'est jamais confondu avec un manifeste. */
export const MIGRATION_JOURNAL_MAGIC = "railsbox-vault/volume-migration";

/** Version du format du JOURNAL. Comme les autres formats persistants, un entier indépendant. */
export const MIGRATION_JOURNAL_VERSION = 1;

// Le nom du journal appartient à la frontière de nommage du support : il est défini une fois, dans
// `opfs-sync-access.mjs`, et réexporté ici pour les appelants de la migration.
export { MIGRATION_JOURNAL_SUFFIX, migrationJournalName };

/** Sérialise le journal de reprise. Déterministe, comme le manifeste. */
export function serialiserJournal({ from, to, sourceManifest, evidence }) {
  return new TextEncoder().encode(
    JSON.stringify({
      magic: MIGRATION_JOURNAL_MAGIC,
      journalVersion: MIGRATION_JOURNAL_VERSION,
      from,
      to,
      sourceManifest,
      evidence,
    }),
  );
}

/** Refus TYPÉ portant sur le journal. Un journal n'est ni supprimé, ni deviné : il est refusé. */
export function journalMalforme(detail, context = {}) {
  return new MigrationError(
    MIGRATION_ERROR_CODES.journalMalformed,
    `Journal de migration illisible : ${detail} Il n'est ni supprimé, ni deviné : l'écarter est un geste explicite.`,
    context,
  );
}

/**
 * Analyse le journal de reprise, ou lève un refus typé. Un journal présent mais illisible fait
 * REFUSER la migration : il signale une migration inachevée dont on ignore l'état de départ, et
 * passer outre reviendrait à réinventer une identité pour le volume.
 */
export function parseJournal(input) {
  let brut;
  try {
    brut = JSON.parse(input instanceof Uint8Array ? new TextDecoder().decode(input) : input);
  } catch {
    throw journalMalforme("JSON invalide.");
  }
  if (!brut || typeof brut !== "object" || brut.magic !== MIGRATION_JOURNAL_MAGIC) {
    throw journalMalforme("marqueur absent ou inconnu.", { magic: brut?.magic ?? null });
  }
  if (brut.journalVersion !== MIGRATION_JOURNAL_VERSION) {
    throw journalMalforme("version de journal non prise en charge.", {
      journalVersion: brut.journalVersion ?? null,
    });
  }
  if (!Number.isInteger(brut.from) || !Number.isInteger(brut.to) || brut.to < brut.from) {
    throw journalMalforme("chaîne de versions absente ou incohérente.", {
      from: brut.from ?? null,
      to: brut.to ?? null,
    });
  }
  if (!brut.evidence || !Object.values(EVIDENCE_KINDS).includes(brut.evidence.kind)) {
    throw journalMalforme("preuve de sauvegarde absente ou inconnue.", {
      kind: brut.evidence?.kind ?? null,
    });
  }
  let sourceManifest;
  try {
    sourceManifest = parseManifest(brut.sourceManifest);
  } catch (cause) {
    throw journalMalforme(`manifeste source invalide (${cause.message}).`);
  }
  return Object.freeze({
    from: brut.from,
    to: brut.to,
    sourceManifest,
    evidence: Object.freeze({ ...brut.evidence }),
  });
}
