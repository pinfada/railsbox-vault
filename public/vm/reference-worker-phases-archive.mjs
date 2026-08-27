// Phases du Worker de référence qui font SORTIR et RENTRER des octets : archive vérifiable (#11) et
// restauration inter-origine (#12).
//
// Trois propriétés les tiennent, et chacune est mesurée plutôt qu'affirmée :
//
//  - **rien n'est tenu en RAM** — la source, le puits et la vérification travaillent par blocs, et
//    la plus grande lecture émise est publiée dans le rapport ;
//  - **seule une archive quitte l'origine** — `phaseArchiveFile` refuse tout ce qui ne porte pas le
//    marqueur `RBVAULT1` (`SEC-ORIGIN-001`) ;
//  - **un refus est typé** — une archive tronquée, altérée, ou un espace insuffisant rendent un code
//    que le scénario peut attendre, jamais un succès silencieux.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { cleDuBanc } from "./cle-du-banc.mjs";
import { createOpfsArchiveSink } from "/src/vm/opfs-archive-sink.mjs";
import { createOpfsImportTarget } from "/src/vm/opfs-import-target.mjs";
import {
  openOpfsSyncAccess,
  openOpfsVolumeFile,
  removeOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { readCountFailure } from "/src/vm/opfs-error-mapping.mjs";
import { STORAGE_ERROR_CODES } from "/src/vm/storage-errors.mjs";
import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";
import { importArchive } from "/src/vm/volume-import.mjs";
import {
  ARCHIVE_MAGIC,
  CONSISTENCY_KINDS,
  backendSource,
  hasArchiveMagic,
  readArchive,
  writeArchive,
} from "/src/vm/volume-export.mjs";
import { ARCHIVE_ERROR_CODES, ArchiveError } from "/src/vm/archive-errors.mjs";
import { VOLUME_ALGORITHM } from "/src/vm/volume-manifest.mjs";
import { manifesteDuDescripteur } from "./reference-worker-boot.mjs";
import {
  EXPORT_BLOCK_BYTES,
  instantaneStockage,
  sourceMesuree,
} from "./reference-worker-mesures.mjs";

/**
 * Ouvre le fichier d'archive et le puits qui l'alimente.
 *
 * Le puits vit dans `src/vm/opfs-archive-sink.mjs` (#73) : la lecture de la valeur de retour d'un
 * `write()` est le point où ce banc a longtemps affirmé une « écriture d'archive courte » là où le
 * support rendait `FILE_ERROR_NO_SPACE` casté en non signé. Un point qui peut mentir doit être
 * testable sans navigateur ; le budget de stockage n'est mesuré qu'en cas d'échec.
 *
 * Le handle est rendu à l'appelant en même temps que le puits : c'est lui qui le referme, dans le
 * `finally` qui doit s'exécuter même si l'écriture échoue.
 */
async function ouvrirPuitsArchive(archive) {
  const handle = await openOpfsSyncAccess(archive);
  const sink = createOpfsArchiveSink(handle, {
    volume: archive,
    measureStorage: () => instantaneStockage(),
  });
  return { handle, sink };
}

/**
 * Compte rendu de l'export. La seule mesure prise ici est le second instantané de stockage : il
 * DATE l'écriture par rapport au quota de l'origine, sans rien conditionner, pour que « il n'y
 * avait plus de place » cesse d'être une hypothèse (#73). `state: "unknown"` dit que le moteur
 * n'estime pas, pas que la capacité est nulle.
 */
async function compteRenduExport({
  volume,
  archive,
  result,
  compteur,
  blockBytes,
  volumeBytes,
  stockageAvant,
}) {
  return {
    phase: "export",
    volume,
    archive,
    storage: { avant: stockageAvant, apres: await instantaneStockage() },
    volumeBytes,
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

/**
 * EXPORTE le volume applicatif OPFS (#11) vers une ARCHIVE OPFS, en flux. La source est lue via le
 * handle exclusif de #6 (aucun autre écrivain dans l'origine) : c'est le point cohérent déclaré. La
 * plus grande lecture est mesurée — un export à surmémoire bornée ne demande jamais tout le volume
 * d'un coup — et l'archive est écrite dans un fichier OPFS distinct, jamais tenue en RAM.
 *
 * Trois gestes depuis #77, et rien d'autre : préparer la cible, verser le flux, rendre compte.
 */
/**
 * Manifeste que l'archive porte. Son identifiant de volume est celui du FICHIER EXPORTÉ, relu de son
 * en-tête v3 par l'ouverture, jamais tiré à l'export : une archive décrit le volume qu'elle porte,
 * et un identifiant neuf en décrirait un autre (ADR 0016).
 */
function manifesteDeLArchive(manifest, tailleSource, backend) {
  return manifesteDuDescripteur(manifest, tailleSource, {
    id: backend.identifiantVolume,
    algorithm: VOLUME_ALGORITHM,
  });
}

export async function phaseExportVolume({
  volume,
  archive,
  manifest,
  blockBytes = EXPORT_BLOCK_BYTES,
}) {
  await removeOpfsVolume(archive);
  const backend = await openOpfsVolume({
    name: volume,
    journal: new BlockJournal(),
    cle: cleDuBanc(),
  });
  const compteur = { maxLecture: 0, blocs: 0 };
  const source = sourceMesuree(backendSource(backend), compteur);
  const { handle, sink } = await ouvrirPuitsArchive(archive);

  const stockageAvant = await instantaneStockage();
  let result;
  try {
    const m = manifesteDeLArchive(manifest, source.size, backend);
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

  return compteRenduExport({
    volume,
    archive,
    result,
    compteur,
    blockBytes,
    volumeBytes: source.size,
    stockageAvant,
  });
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
 * Lecture d'archive qui distingue une lecture COURTE d'un CODE D'ÉCHEC (#73).
 *
 * La courte est rendue telle quelle : `readArchive` en fait une troncature typée, et c'est
 * précisément ce que le scénario éprouve. Le code d'échec, lui, n'est pas un compte — `subarray` le
 * bornerait à `length` et rendrait un tampon de zéros comme s'il avait été lu, et l'archive se
 * vérifierait alors contre du vide.
 */
function lecteurDArchive(handle, archive, compteur) {
  return (offset, length) => {
    compteur.maxLecture = Math.max(compteur.maxLecture, length);
    const buffer = new Uint8Array(length);
    const lus = handle.read(buffer, { at: offset });
    const echec = readCountFailure(lus, {
      requested: length,
      volume: archive,
      offset,
      operation: "read-archive",
    });
    if (echec !== null && echec.code !== STORAGE_ERROR_CODES.shortRead) throw echec;
    return lus === length ? buffer : buffer.subarray(0, lus);
  };
}

/**
 * VÉRIFIE l'archive OPFS (#11) en STREAMING : recalcule l'empreinte du contenu et valide le
 * manifeste. `mutate` permet d'éprouver les refus typés (contenu altéré, archive tronquée). La
 * vérification rend un verdict ou un échec typé — jamais un succès silencieux.
 */
export async function phaseVerifyExport({
  archive,
  mutate = "none",
  blockBytes = EXPORT_BLOCK_BYTES,
}) {
  await muterArchive(archive, mutate);
  const handle = await openOpfsSyncAccess(archive);
  const byteLength = handle.getSize();
  const compteur = { maxLecture: 0 };
  const read = lecteurDArchive(handle, archive, compteur);

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

/**
 * Rend l'archive OPFS sous forme de `File`, pour que la coquille la remette au navigateur. C'est le
 * geste d'EXPORT côté utilisateur : l'archive quitte l'origine par le système de fichiers de l'hôte,
 * jamais par un canal inter-origines — la CSP de la coquille n'en ouvre aucun.
 */
export async function phaseArchiveFile({ archive }) {
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
export async function phaseImport({
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
