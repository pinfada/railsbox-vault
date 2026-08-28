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

/**
 * Version du format du JOURNAL. Comme les autres formats persistants, un entier indépendant.
 *
 * **2 depuis #101.** Le journal porte désormais l'AVANCEMENT de la migration en cours — l'étape
 * franchie et la position atteinte —, parce que la conversion v2 → v3 est la première qui touche
 * les octets et que sa reprise ne peut pas se déduire de l'état du fichier. Un journal v1 lu par ce
 * runtime est refusé plutôt qu'interprété : il décrit une migration qui n'écrivait rien, et lui
 * prêter un avancement serait inventer ce qu'on ignore.
 */
export const MIGRATION_JOURNAL_VERSION = 2;

// Le nom du journal appartient à la frontière de nommage du support : il est défini une fois, dans
// `opfs-sync-access.mjs`, et réexporté ici pour les appelants de la migration.
export { MIGRATION_JOURNAL_SUFFIX, migrationJournalName };

/**
 * Sérialise le journal de reprise. Déterministe, comme le manifeste.
 *
 * `progress` porte l'avancement d'une conversion qui écrit : `{ etape, position }`. Il est ABSENT
 * tant qu'aucune étape mutante n'a commencé, et c'est une information en soi — une migration qui
 * n'écrit rien, comme v1 → v2, n'en produit jamais.
 */
export function serialiserJournal({ from, to, sourceManifest, evidence, progress = null }) {
  return new TextEncoder().encode(
    JSON.stringify({
      magic: MIGRATION_JOURNAL_MAGIC,
      journalVersion: MIGRATION_JOURNAL_VERSION,
      from,
      to,
      sourceManifest,
      evidence,
      ...(progress === null ? {} : { progress }),
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
 * Analyse l'AVANCEMENT porté par un journal, ou `null` s'il n'y en a pas.
 *
 * Un avancement à moitié lisible est REFUSÉ, jamais complété : reprendre une conversion à une
 * position devinée écrirait du clair par-dessus du chiffré, ou l'inverse. « Absent » est un état
 * légitime — aucune étape mutante n'a commencé — ; « présent et douteux » ne l'est pas.
 */
function analyserAvancement(progress) {
  if (progress === undefined || progress === null) return null;
  if (typeof progress !== "object" || typeof progress.etape !== "string") {
    throw journalMalforme("avancement présent mais sans étape nommée.", {
      etape: progress?.etape ?? null,
    });
  }
  if (!Number.isInteger(progress.position) || progress.position < 0) {
    throw journalMalforme("avancement présent mais sans position entière.", {
      position: progress?.position ?? null,
    });
  }
  // À QUEL PAS DE LA CHAÎNE cet avancement se rapporte. Une chaîne compte plusieurs pas — v1 → v2
  // puis v2 → v3 —, et un avancement qui ne dit pas lequel serait consommé par le premier venu :
  // la conversion recevrait alors « rien de commencé » et redéplacerait la charge par-dessus une
  // région déjà scellée. C'est ce que la revue de #110 a trouvé, masqué par un autre défaut.
  if (!Number.isInteger(progress.from) || !Number.isInteger(progress.to)) {
    throw journalMalforme("avancement présent mais sans le pas de chaîne qu'il décrit.", {
      from: progress?.from ?? null,
      to: progress?.to ?? null,
    });
  }
  // L'IDENTIFIANT du volume en cours de conversion, quand l'étape en a tiré un. Il entre dans les
  // données associées de chaque secteur scellé : une reprise qui en tirerait un autre ne
  // reconnaîtrait plus rien de ce qui est déjà converti. Facultatif — une étape qui ne chiffre pas
  // n'en a aucun —, mais refusé s'il est présent et malformé, comme tout le reste du journal.
  if (
    progress.identifiantVolume !== undefined &&
    !/^[0-9a-f]{32}$/.test(progress.identifiantVolume)
  ) {
    throw journalMalforme("avancement présent avec un identifiant de volume inadmissible.", {
      identifiantVolume: progress.identifiantVolume ?? null,
    });
  }
  return Object.freeze({
    from: progress.from,
    to: progress.to,
    etape: progress.etape,
    position: progress.position,
    identifiantVolume: progress.identifiantVolume ?? null,
  });
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
    progress: analyserAvancement(brut.progress),
  });
}
