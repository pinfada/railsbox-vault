// Worker runtime de la preuve de reprise (#7). C'est le SEUL contexte autorisé à ouvrir le handle
// exclusif OPFS et à porter v86 (ADR 0002) : la coquille ne reçoit que des données JSON.
//
// Les phases sont appelées chacune dans un Worker NEUF par le test E2E, pour que « fermer page +
// Worker + handles » soit réel entre elles :
//
//   prepare       volume OPFS neuf, le disque applicatif de l'image #5 y est écrit puis flushé.
//   live          Rails boote sur ce disque OPFS en écriture ; ses écritures traversent le pont de
//                 durabilité jusqu'à OPFS ; l'invariant est vérifié à chaud.
//   resume        BOOT À FROID depuis le même volume OPFS (aucun snapshot), invariant revérifié.
//   resume-arm/   reprise hors ligne en deux temps : `arm` acquiert le runtime EN LIGNE, le test
//   resume-fire   coupe le réseau, puis `fire` boote à froid et vérifie SANS aucun accès réseau.
//   prepare-empty volume vide (témoin négatif) ; cleanup le retire.
//   export/import  archive vérifiable (#11) et restauration inter-origine (#12).
//   migrate        migration de format et reprise d'une migration interrompue (#13).
//
// L'acquisition du runtime et le boot vérifié vivent dans `./reference-worker-boot.mjs` : ce
// fichier serait sinon au-delà du plafond de 800 lignes du dépôt.
//
// Aucune phase ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et
// l'assertion vit dans les spécifications de `tests/e2e/`.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { createOpfsArchiveSink } from "/src/vm/opfs-archive-sink.mjs";
import { createOpfsImportTarget } from "/src/vm/opfs-import-target.mjs";
import { createOpfsMigrationTarget } from "/src/vm/opfs-migration-target.mjs";
import {
  migrationJournalName,
  openOpfsSyncAccess,
  openOpfsVolumeFile,
  removeOpfsVolume,
  statOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { revokeVolumeManifest, writeVolumeManifest } from "/src/vm/opfs-volume-open.mjs";
import { readCountFailure } from "/src/vm/opfs-error-mapping.mjs";
import { STORAGE_ERROR_CODES } from "/src/vm/storage-errors.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";
import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";
import { importArchive, manifestSidecarName } from "/src/vm/volume-import.mjs";
import { migrateVolume } from "/src/vm/volume-migration.mjs";
import {
  attentesDe,
  acquerirRuntime,
  bootEtVerifier,
  manifesteDuDescripteur,
} from "./reference-worker-boot.mjs";
import {
  ARCHIVE_MAGIC,
  CONSISTENCY_KINDS,
  backendSource,
  hasArchiveMagic,
  readArchive,
  writeArchive,
} from "/src/vm/volume-export.mjs";
import { ARCHIVE_ERROR_CODES, ArchiveError } from "/src/vm/archive-errors.mjs";

/**
 * État armé de la reprise hors ligne. La reprise se joue en deux temps pour prouver que le RÉSEAU
 * ne participe pas au boot à froid : `resume-arm` acquiert le runtime pendant que la page est en
 * ligne, puis le test coupe le réseau, puis `resume-fire` boote et vérifie SANS aucun accès réseau.
 */
let armed = null;

/**
 * Écrit le disque applicatif de l'image #5 dans un volume OPFS neuf, en flux : aucun tampon de
 * 512 Mio n'est jamais tenu en mémoire. C'est le point technique dur de #7 — faire pointer le
 * disque `hdb` de v86 vers OPFS en écriture — traité côté données : le disque naît dans OPFS.
 */
async function phasePrepare({ volume, appDiskBytes, appDiskUrl, manifest }) {
  const identites = attentesDe(manifest);
  await removeOpfsVolume(volume);
  // Le volume naît anonyme : son manifeste ne sera inscrit qu'une fois le disque écrit et flushé.
  // Un volume à moitié préparé est donc, lui aussi, non identifié — la même règle qu'à la
  // restauration, appliquée à la création.
  await revokeVolumeManifest(volume);
  const journal = new BlockJournal();
  // SANS génération transactionnelle (#16, ADR 0014), pour la même raison qu'à la restauration :
  // écrire un disque applicatif de plusieurs centaines de mébioctets d'un seul tenant n'est pas une
  // génération du guest, et la création porte déjà son atomicité — le manifeste n'est inscrit
  // qu'après le disque écrit et flushé, si bien qu'un volume à moitié préparé reste non identifié.
  const backend = await openOpfsVolume({
    name: volume,
    size: appDiskBytes,
    journal,
    transactionnel: false,
  });
  let offset = 0;
  try {
    const response = await fetch(appDiskUrl, { cache: "no-store" });
    if (!response.ok || response.body === null) {
      throw new Error(`Disque applicatif ${appDiskUrl} indisponible (${response.status}).`);
    }
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      await backend.write(offset, value);
      offset += value.byteLength;
    }
    await backend.flush();
  } finally {
    await backend.close();
  }
  if (offset !== appDiskBytes) {
    throw new Error(`Disque applicatif tronqué : ${offset} octets écrits sur ${appDiskBytes}.`);
  }
  // Dernier geste : le volume devient identifié, donc ouvrable en écriture. Le format inscrit est
  // celui que le descripteur demande — un scénario de migration prépare délibérément un volume au
  // format ANTÉRIEUR, sans quoi il n'aurait rien à migrer.
  const inscrit = manifesteDuDescripteur(manifest, appDiskBytes);
  await writeVolumeManifest(volume, inscrit);
  return {
    phase: "prepare",
    volume,
    bytesWritten: offset,
    formatVersion: inscrit.formatVersion,
    counts: journal.counts(),
    identified: identites,
  };
}

async function phaseLive(options) {
  return bootEtVerifier({ ...options, phase: "live" });
}

async function phaseResume(options) {
  return bootEtVerifier({ ...options, phase: "resume" });
}

/**
 * Boot identique à `live`, mais qui ANNONCE l'instant où le guest a muté le volume et acquitté une
 * barrière (#16). Il ne coupe rien : c'est la PAGE qui ferme, et fermer une page tue son Worker avec
 * son handle exclusif, sans fermeture propre et sans barrière — la coupure la plus réaliste que ce
 * dépôt sache produire sans tuer le navigateur lui-même.
 *
 * Le message d'annonce ne porte AUCUN identifiant de requête : il n'est la réponse de personne. Le
 * banc l'écoute à part, et la promesse de la phase ne se résout jamais si la page coupe — ce qui est
 * exactement ce qu'on veut mesurer.
 */
async function phaseLiveCouper(options) {
  return bootEtVerifier({
    ...options,
    phase: "live-couper",
    surMutation: (etat) => self.postMessage({ type: "mutation", ...etat }),
  });
}

/** Arme la reprise hors ligne : acquiert le runtime PENDANT que la page est en ligne. */
async function phaseResumeArm(options) {
  const bundle = await acquerirRuntime(options.runtime);
  armed = { bundle, options };
  return {
    phase: "resume-arm",
    ready: true,
    transferredBytes: bundle.transferredBytes,
    online: navigator.onLine,
  };
}

/** Tire la reprise : boot à froid + vérification, réseau coupé, depuis le runtime déjà en mémoire. */
async function phaseResumeFire(options) {
  if (armed === null) {
    throw new Error("resume-fire sans resume-arm : le runtime n'a pas été acquis en ligne.");
  }
  const { bundle, options: armedOptions } = armed;
  armed = null;
  return bootEtVerifier({
    ...armedOptions,
    ...options,
    phase: "resume",
    runtimeBundle: bundle,
  });
}

/**
 * Témoin négatif : un volume OPFS NEUF et vide (que des zéros). Un boot dessus ne peut pas monter
 * `/dev/sdb` ni servir l'invariant — ce qui prouve que la reprise dépend du CONTENU d'OPFS, et non
 * du réseau ou de l'artefact resservi.
 */
async function phasePrepareEmpty({ volume, appDiskBytes, manifest }) {
  attentesDe(manifest);
  await removeOpfsVolume(volume);
  // Même règle qu'à la préparation : le volume naît ANONYME. Sans cette révocation, un manifeste
  // hérité d'une exécution précédente identifierait le volume vide pendant toute sa fabrication.
  await revokeVolumeManifest(volume);
  const backend = await openOpfsVolume({
    name: volume,
    size: appDiskBytes,
    journal: new BlockJournal(),
  });
  await backend.flush();
  await backend.close();
  // Le témoin est IDENTIFIÉ comme n'importe quel volume, mais VIDE. Sans manifeste, il serait
  // refusé pour non-identification (#12) et ne dirait plus rien du CONTENU d'OPFS — qui est
  // précisément ce qu'il doit prouver.
  await writeVolumeManifest(volume, manifesteDuDescripteur(manifest, appDiskBytes));
  return { phase: "prepare-empty", volume, appDiskBytes };
}

/** Retire un volume OPFS ET tous ses voisins : rend le profil réellement « neuf ». */
async function phaseCleanup({ volume }) {
  const retire = await removeOpfsVolume(volume);
  const manifesteRetire = await revokeVolumeManifest(volume);
  const journalRetire = await removeOpfsVolume(migrationJournalName(volume));
  return {
    phase: "cleanup",
    volume,
    removed: retire,
    manifestRemoved: manifesteRetire,
    migrationJournalRemoved: journalRetire,
  };
}

/**
 * Retire le SEUL manifeste voisin, en laissant le volume intact. C'est l'état exact que laisse une
 * restauration interrompue : le test s'en sert pour vérifier que le boot suivant est bien refusé.
 */
async function phaseRevokeManifest({ volume }) {
  const revoked = await revokeVolumeManifest(volume);
  return { phase: "revoke-manifest", volume, revoked };
}

/** Bloc de streaming de l'export/vérification E2E : 4 Mio, très en deçà du budget de surmémoire. */
const EXPORT_BLOCK_BYTES = 4 * 1024 * 1024;

/**
 * INSTANTANÉ du budget de stockage de l'origine (#9), pris pour être PUBLIÉ (#73).
 *
 * Il ne décide de rien et ne bloque rien : il donne au rapport de quoi situer une écriture par
 * rapport au quota que le moteur accorde. Un moteur qui n'estime pas rend l'état `unknown` — une
 * inconnue, jamais une capacité nulle, exactement comme le pose `storage-budget.mjs`.
 */
async function instantaneStockage() {
  const budget = createStorageBudget(bindNavigatorStorage(navigator.storage));
  const mesure = await budget.measure();
  return {
    state: mesure.state,
    quota: mesure.quota,
    usage: mesure.usage,
    available: mesure.available,
  };
}

/**
 * Enveloppe une source d'export pour COMPTER ses lectures. La plus grande lecture émise est la
 * preuve déterministe qu'un export à surmémoire bornée ne demande jamais tout le volume d'un coup :
 * elle est mesurée ici, pas déclarée ailleurs.
 */
function sourceMesuree(base, compteur) {
  return {
    size: base.size,
    read(offset, length) {
      compteur.maxLecture = Math.max(compteur.maxLecture, length);
      compteur.blocs += 1;
      return base.read(offset, length);
    },
  };
}

/**
 * EXPORTE le volume applicatif OPFS (#11) vers une ARCHIVE OPFS, en flux. La source est lue via le
 * handle exclusif de #6 (aucun autre écrivain dans l'origine) : c'est le point cohérent déclaré. La
 * plus grande lecture est mesurée — un export à surmémoire bornée ne demande jamais tout le volume
 * d'un coup — et l'archive est écrite dans un fichier OPFS distinct, jamais tenue en RAM.
 */
async function phaseExportVolume({ volume, archive, manifest, blockBytes = EXPORT_BLOCK_BYTES }) {
  await removeOpfsVolume(archive);
  const backend = await openOpfsVolume({ name: volume, journal: new BlockJournal() });
  const compteur = { maxLecture: 0, blocs: 0 };
  const source = sourceMesuree(backendSource(backend), compteur);

  const handle = await openOpfsSyncAccess(archive);
  // Le puits vit dans `src/vm/opfs-archive-sink.mjs` (#73) : la lecture de la valeur de retour d'un
  // `write()` est le point où ce banc a longtemps affirmé une « écriture d'archive courte » là où le
  // support rendait `FILE_ERROR_NO_SPACE` casté en non signé. Un point qui peut mentir doit être
  // testable sans navigateur ; le budget de stockage n'est mesuré qu'en cas d'échec.
  const sink = createOpfsArchiveSink(handle, {
    volume: archive,
    measureStorage: () => instantaneStockage(),
  });

  const stockageAvant = await instantaneStockage();
  let result;
  try {
    const m = manifesteDuDescripteur(manifest, source.size);
    result = await writeArchive({
      source,
      sink,
      manifest: m,
      consistency: {
        kind: CONSISTENCY_KINDS.exclusiveHandle,
        detail: "volume lu via le handle OPFS exclusif (#6), aucun autre écrivain dans l'origine",
      },
      blockBytes,
    });
    sink.flush();
  } finally {
    handle.close();
    await backend.close();
  }

  return {
    phase: "export",
    volume,
    archive,
    // Budget de stockage encadrant l'export (#73). Il ne conditionne rien : il DATE l'écriture par
    // rapport au quota de l'origine, pour que « il n'y avait plus de place » cesse d'être une
    // hypothèse. `state: "unknown"` dit que le moteur n'estime pas, pas que la capacité est nulle.
    storage: { avant: stockageAvant, apres: await instantaneStockage() },
    volumeBytes: source.size,
    archiveLength: result.archiveLength,
    headerLength: result.headerLength,
    contentLength: result.contentLength,
    digest: result.digest,
    manifestDigest: result.manifest.identity.digest,
    consistency: result.consistency,
    maxBlockBytes: compteur.maxLecture,
    blocs: compteur.blocs,
    blockBytes,
  };
}

/** Applique une altération sur l'archive AVANT vérification, pour éprouver les refus typés. */
async function muterArchive(archive, mutate) {
  if (mutate === "none") return;
  const handle = await openOpfsSyncAccess(archive);
  try {
    const size = handle.getSize();
    if (mutate === "truncate") {
      handle.truncate(Math.max(0, size - 512));
    } else if (mutate === "tamper") {
      const octet = new Uint8Array(1);
      handle.read(octet, { at: size - 100 });
      octet[0] ^= 0x01;
      handle.write(octet, { at: size - 100 });
    } else {
      throw new Error(`Altération inconnue : ${mutate}.`);
    }
    handle.flush();
  } finally {
    handle.close();
  }
}

/**
 * VÉRIFIE l'archive OPFS (#11) en STREAMING : recalcule l'empreinte du contenu et valide le
 * manifeste. `mutate` permet d'éprouver les refus typés (contenu altéré, archive tronquée). La
 * vérification rend un verdict ou un échec typé — jamais un succès silencieux.
 */
async function phaseVerifyExport({ archive, mutate = "none", blockBytes = EXPORT_BLOCK_BYTES }) {
  await muterArchive(archive, mutate);
  const handle = await openOpfsSyncAccess(archive);
  const byteLength = handle.getSize();
  const compteur = { maxLecture: 0 };
  const read = (offset, length) => {
    compteur.maxLecture = Math.max(compteur.maxLecture, length);
    const buffer = new Uint8Array(length);
    const lus = handle.read(buffer, { at: offset });
    // Une lecture COURTE est rendue telle quelle : `readArchive` en fait une troncature typée, et
    // c'est précisément ce que le scénario éprouve. Un CODE D'ÉCHEC, lui, n'est pas un compte
    // (#73) : `subarray` le bornerait à `length` et rendrait un tampon de zéros comme s'il avait
    // été lu — l'archive se vérifierait alors contre du vide.
    const echec = readCountFailure(lus, {
      requested: length,
      volume: archive,
      offset,
      operation: "read-archive",
    });
    if (echec !== null && echec.code !== STORAGE_ERROR_CODES.shortRead) throw echec;
    return lus === length ? buffer : buffer.subarray(0, lus);
  };

  let verdict = null;
  let error = null;
  try {
    verdict = await readArchive({ read, byteLength, blockBytes });
  } catch (cause) {
    error = { name: cause.name, code: cause.code ?? null, message: cause.message };
  } finally {
    handle.close();
  }

  return {
    phase: "verify-export",
    archive,
    mutate,
    byteLength,
    ok: verdict !== null,
    contentDigest: verdict?.contentDigest ?? null,
    contentLength: verdict?.contentLength ?? null,
    consistency: verdict?.consistency ?? null,
    manifestDigest: verdict?.manifest?.identity?.digest ?? null,
    maxBlockBytes: compteur.maxLecture,
    error,
  };
}

// --- Restauration inter-origine (#12) ---------------------------------------------------------

/**
 * OBSERVE un volume et son manifeste voisin, sans rien créer ni ouvrir en exclusivité. C'est ce qui
 * permet au test de prouver l'ISOLATION D'ORIGINE — l'OPFS de l'origine de restauration ignore tout
 * du volume de l'origine d'export — et, après un refus, qu'aucun octet n'a été écrit.
 */
async function phaseInspectVolume({ volume }) {
  const etat = await statOpfsVolume(volume);
  const manifeste = await statOpfsVolume(manifestSidecarName(volume));
  // Le journal de migration (#13) est observé au même titre : sa présence signale une migration
  // inachevée, et c'est ce que le scénario d'interruption doit pouvoir constater.
  const journalMigration = await statOpfsVolume(migrationJournalName(volume));
  return {
    phase: "inspect-volume",
    volume,
    present: etat.present,
    size: etat.size,
    manifestPresent: manifeste.present && manifeste.size > 0,
    manifestSize: manifeste.size,
    migrationJournalPresent: journalMigration.present && journalMigration.size > 0,
    migrationJournalSize: journalMigration.size,
  };
}

/**
 * Empreinte SHA-256 du CONTENU d'un volume OPFS, relue en flux depuis le support. Elle ne sert pas
 * la restauration elle-même : elle donne au test un moyen INDÉPENDANT de comparer octet pour octet
 * le volume de l'origine d'export et celui de l'origine de restauration.
 */
async function phaseDigestVolume({ volume, blockBytes = EXPORT_BLOCK_BYTES }) {
  const backend = await openOpfsVolume({ name: volume, journal: new BlockJournal() });
  const hash = createSha256Stream();
  let maxLecture = 0;
  try {
    const taille = backend.size();
    for (let offset = 0; offset < taille; offset += blockBytes) {
      const length = Math.min(blockBytes, taille - offset);
      maxLecture = Math.max(maxLecture, length);
      hash.update(await backend.read(offset, length));
    }
    return {
      phase: "digest-volume",
      volume,
      size: taille,
      digest: hash.digestHex(),
      maxBlockBytes: maxLecture,
    };
  } finally {
    await backend.close();
  }
}

/**
 * Rend l'archive OPFS sous forme de `File`, pour que la coquille la remette au navigateur. C'est le
 * geste d'EXPORT côté utilisateur : l'archive quitte l'origine par le système de fichiers de l'hôte,
 * jamais par un canal inter-origines — la CSP de la coquille n'en ouvre aucun.
 */
async function phaseArchiveFile({ archive }) {
  const file = await openOpfsVolumeFile(archive);
  // Le nom demandé ne prouve rien : c'est le CONTENU qui décide. Huit octets suffisent — si le
  // marqueur `RBVAULT1` n'est pas là, ce n'est pas une archive, et la coquille n'obtiendra pas de
  // vue sur ces octets (`SEC-ORIGIN-001` : l'archive, jamais le volume). Le fichier étant adossé au
  // support, cette lecture ne charge rien d'autre que ces huit octets.
  const tete = new Uint8Array(await file.slice(0, ARCHIVE_MAGIC.byteLength).arrayBuffer());
  if (!hasArchiveMagic(tete)) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.malformed,
      `Extraction refusée : « ${archive} » ne porte pas le marqueur d'archive Vault. Seule une archive quitte l'origine ; un volume, jamais.`,
      { volume: archive, byteLength: file.size },
    );
  }
  return { phase: "archive-file", archive, byteLength: file.size, file };
}

/**
 * RESTAURE un volume OPFS depuis une archive remise à cette origine (#12). L'archive est un `File` :
 * elle est lue par tranches, jamais chargée en entier. La couche budget de #9 est branchée, si le
 * moteur l'expose, pour refuser l'espace insuffisant AVANT toute mutation.
 *
 * La phase ne lève pas : elle rend `ok` et, le cas échéant, l'erreur TYPÉE — c'est le test qui
 * décide si un refus était attendu.
 */
async function phaseImport({
  volume,
  archiveFile,
  expectations = {},
  overwrite = false,
  blockBytes = EXPORT_BLOCK_BYTES,
}) {
  if (!archiveFile || typeof archiveFile.slice !== "function") {
    throw new Error("Aucune archive n'a été remise à cette origine.");
  }
  const compteur = { maxLecture: 0 };
  const source = {
    byteLength: archiveFile.size,
    async read(offset, length) {
      compteur.maxLecture = Math.max(compteur.maxLecture, length);
      return new Uint8Array(await archiveFile.slice(offset, offset + length).arrayBuffer());
    },
  };
  const journal = new BlockJournal();
  const target = createOpfsImportTarget(volume, { journal });
  const budget = createStorageBudget(bindNavigatorStorage(navigator.storage));

  const debut = performance.now();
  const duree = () => Number((performance.now() - debut).toFixed(1));
  try {
    const rapport = await importArchive({
      source,
      target,
      expectations,
      overwrite,
      blockBytes,
      budget,
    });
    return rapportImport({ volume, rapport, compteur, journal, durationMs: duree() });
  } catch (cause) {
    return {
      phase: "import",
      volume,
      ok: false,
      restored: false,
      error: {
        name: cause.name,
        code: cause.code ?? null,
        message: cause.message,
        context: cause.context ?? null,
      },
      durationMs: duree(),
    };
  }
}

/** Compte rendu JSON d'une restauration réussie, tel que la coquille le reçoit. */
function rapportImport({ volume, rapport, compteur, journal, durationMs }) {
  return {
    phase: "import",
    volume,
    ok: true,
    error: null,
    restored: rapport.restored,
    overwritten: rapport.overwritten,
    volumeSize: rapport.volumeSize,
    contentDigest: rapport.contentDigest,
    verifiedDigest: rapport.verifiedDigest,
    manifestDigest: rapport.manifest.identity.digest,
    manifestApp: rapport.manifest.app,
    archiveConsistency: rapport.archiveConsistency,
    archiveLength: rapport.archiveLength,
    blockBytes: rapport.blockBytes,
    maxSourceReadBytes: Math.max(rapport.maxSourceReadBytes, compteur.maxLecture),
    maxTargetWriteBytes: rapport.maxTargetWriteBytes,
    maxTargetReadBytes: rapport.maxTargetReadBytes,
    budget: rapport.budget,
    counts: journal.counts(),
    durationMs,
  };
}

// --- Migration de format (#13) ------------------------------------------------------------------

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
async function phaseMigrate({
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

/** Feasibilité : prepare puis live dans un même Worker. Le test E2E n'utilise pas cette phase. */
async function phaseFull(options) {
  const prepare = await phasePrepare(options);
  const live = await phaseLive(options);
  return { phase: "full", prepare, live };
}

const PHASES = new Map([
  ["prepare", phasePrepare],
  ["prepare-empty", phasePrepareEmpty],
  ["cleanup", phaseCleanup],
  ["live", phaseLive],
  ["resume", phaseResume],
  ["resume-arm", phaseResumeArm],
  ["resume-fire", phaseResumeFire],
  ["export", phaseExportVolume],
  ["verify-export", phaseVerifyExport],
  ["revoke-manifest", phaseRevokeManifest],
  ["inspect-volume", phaseInspectVolume],
  ["digest-volume", phaseDigestVolume],
  ["archive-file", phaseArchiveFile],
  ["import", phaseImport],
  ["migrate", phaseMigrate],
  ["full", phaseFull],
]);

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  const options = payload ?? {};
  const runner = PHASES.get(options.phase ?? "full");
  if (!runner) {
    self.postMessage({ id, ok: false, error: { message: `Phase inconnue : ${options.phase}` } });
    return;
  }
  runner(options).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) =>
      self.postMessage({
        id,
        ok: false,
        // Le CONTEXTE traverse le port au même titre que le code (#73). Sans lui, un échec de
        // support arrive en CI réduit à une phrase : ni offset, ni quota, ni errno — c'est-à-dire
        // sans rien de ce qui permet de le diagnostiquer. Il ne porte que des nombres et des noms.
        error: {
          name: error.name,
          code: error.code ?? null,
          message: error.message,
          context: error.context ?? null,
        },
      }),
  );
});
