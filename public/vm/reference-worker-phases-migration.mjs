// Phase du Worker de référence qui MIGRE un volume de format, ou REPREND une migration interrompue
// (#13).
//
// Elle porte le seul mécanisme du Worker qui existe pour les scénarios et non pour le produit : les
// POINTS D'INTERRUPTION nommés. Une migration interrompue est le cas que le contrat doit tenir, et
// l'éprouver suppose de pouvoir la couper à un endroit précis plutôt que d'espérer une panne.
//
// La phase ne lève pas : elle rend `ok` et, le cas échéant, l'erreur TYPÉE — c'est le scénario qui
// décide si un refus était attendu.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { createOpfsMigrationTarget } from "/src/vm/opfs-migration-target.mjs";
import { openOpfsVolumeFile } from "/src/vm/opfs-sync-access.mjs";
import { cleDuBanc } from "./cle-du-banc.mjs";
import { migrateVolume } from "/src/vm/volume-migration.mjs";
import { attentesDe } from "./reference-worker-boot.mjs";
import { EXPORT_BLOCK_BYTES } from "./reference-worker-mesures.mjs";

/**
 * Points d'interruption nommés d'une migration. Ils ne servent QU'aux scénarios : une migration
 * interrompue est le cas que le contrat doit tenir, et l'éprouver suppose de pouvoir la couper à un
 * endroit précis plutôt que d'espérer une panne. Le geste visé s'exécute, PUIS la migration échoue —
 * c'est exactement ce que laisse derrière lui un onglet fermé.
 */
const POINTS_INTERRUPTION = Object.freeze({
  "write-journal": "writeJournal",
  revoke: "revokeManifest",
  commit: "commitManifest",
});

/** Enveloppe la cible pour qu'un geste nommé réussisse puis fasse échouer la migration. */
function interrompreApres(cible, point) {
  if (point === null || point === undefined) return cible;
  const membre = POINTS_INTERRUPTION[point];
  if (membre === undefined) {
    throw new Error(
      `Point d'interruption inconnu : ${point}. Attendu l'un de ${Object.keys(POINTS_INTERRUPTION).join(", ")}.`,
    );
  }
  const original = cible[membre].bind(cible);
  return {
    ...cible,
    async [membre](...args) {
      await original(...args);
      throw new Error(`Migration interrompue après « ${point} » (panne injectée par le scénario).`);
    },
  };
}

/**
 * Rend une archive OPFS sous forme de SOURCE lisible par tranches, pour servir de preuve de
 * sauvegarde. Le `File` est adossé au support : l'archive n'est jamais tenue en mémoire.
 */
async function sourceDeSauvegarde(archive) {
  const fichier = await openOpfsVolumeFile(archive);
  return {
    byteLength: fichier.size,
    async read(offset, length) {
      return new Uint8Array(await fichier.slice(offset, offset + length).arrayBuffer());
    },
  };
}

/**
 * MIGRE un volume OPFS vers le format courant, ou REPREND une migration interrompue (#13).
 *
 * La phase ne lève pas : elle rend `ok` et, le cas échéant, l'erreur TYPÉE — c'est le scénario qui
 * décide si un refus était attendu.
 */
export async function phaseMigrate({
  volume,
  manifest,
  backupArchive = null,
  consent = null,
  interruptAfter = null,
  blockBytes = EXPORT_BLOCK_BYTES,
}) {
  const attentes = attentesDe(manifest);
  const journal = new BlockJournal();
  const cible = interrompreApres(createOpfsMigrationTarget(volume, { journal }), interruptAfter);
  const backup =
    backupArchive === null ? null : { source: await sourceDeSauvegarde(backupArchive) };

  const debut = performance.now();
  const duree = () => Number((performance.now() - debut).toFixed(1));
  try {
    const rapport = await migrateVolume({
      target: cible,
      expectations: attentes,
      backup,
      consent,
      // La conversion v2 → v3 SCELLE : elle a besoin de la clé, et le banc la reçoit du harnais
      // sous jeton, comme tout le reste (ADR 0016, décision 6). Aucun chemin du produit n'en
      // fabrique une, et une migration qui en inventerait une chiffrerait le volume sous un secret
      // que personne ne connaît.
      cle: cleDuBanc(),
      blockBytes,
    });
    return migrationReussie({ volume, rapport, counts: journal.counts(), durationMs: duree() });
  } catch (cause) {
    return migrationRefusee({ volume, cause, counts: journal.counts(), durationMs: duree() });
  }
}

/** Compte rendu d'une migration ABOUTIE, tel que le scénario le reçoit en JSON. */
function migrationReussie({ volume, rapport, counts, durationMs }) {
  return {
    phase: "migrate",
    volume,
    ok: true,
    error: null,
    migrated: rapport.migrated,
    resumed: rapport.resumed,
    fromVersion: rapport.fromVersion,
    toVersion: rapport.toVersion,
    evidence: rapport.evidence,
    steps: rapport.steps,
    minWriter: rapport.manifest.runtime.minWriter ?? null,
    counts,
    durationMs,
  };
}

/** Compte rendu d'une migration REFUSÉE : le code typé traverse le port, il ne se perd pas en route. */
function migrationRefusee({ volume, cause, counts, durationMs }) {
  return {
    phase: "migrate",
    volume,
    ok: false,
    migrated: false,
    error: {
      name: cause.name,
      code: cause.code ?? null,
      message: cause.message,
      context: cause.context ?? null,
    },
    counts,
    durationMs,
  };
}
