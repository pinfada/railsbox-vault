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
//
// Aucune phase ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et
// l'assertion vit dans `tests/e2e/reprise-mutation-boot-froid.spec.mjs`.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { createOpfsImportTarget } from "/src/vm/opfs-import-target.mjs";
import {
  openOpfsSyncAccess,
  openOpfsVolumeFile,
  removeOpfsVolume,
  statOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import {
  openVolumeForWrite,
  revokeVolumeManifest,
  writeVolumeManifest,
} from "/src/vm/opfs-volume-open.mjs";
import { createReferenceGuestSession } from "/src/vm/reference-guest-session.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";
import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { createManifest } from "/src/vm/volume-manifest.mjs";
import { importArchive, manifestSidecarName } from "/src/vm/volume-import.mjs";
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
 * Identités du volume, telles qu'un scénario les déclare. Elles servent DEUX fois : à inscrire le
 * manifeste quand le volume est créé, et à l'exiger quand il est rouvert en écriture.
 * `SEC-UPDATE-001` n'admet aucun volume anonyme, donc aucune phase écrivante sans descripteur.
 */
function attentesDe(manifest) {
  if (!manifest?.app?.id || !manifest?.runtime?.version) {
    throw new Error(
      "Descripteur de manifeste requis : un volume ne s'ouvre en écriture que s'il est identifié (SEC-UPDATE-001).",
    );
  }
  return { app: { id: manifest.app.id }, runtime: { version: manifest.runtime.version } };
}

/**
 * v86 choisit sa boucle d'ordonnancement à l'initialisation : `scheduler.postTask` si son URL
 * contient `use-scheduling-api`, sinon un Worker imbriqué `blob:` que la CSP de la coquille refuse.
 * La condition est vérifiée AVANT tout démarrage, et son absence est une erreur explicite.
 */
function assertSchedulingApi() {
  if (!location.href.includes("use-scheduling-api")) {
    throw new Error(
      "Le Worker runtime doit être chargé avec « ?use-scheduling-api » : sinon v86 tente un Worker imbriqué « blob: » que la CSP refuse.",
    );
  }
  if (typeof globalThis.scheduler?.postTask !== "function") {
    throw new Error(
      "scheduler.postTask est absent de ce moteur : v86 ne peut pas battre sous la CSP de la coquille. Voir docs/compatibility.md.",
    );
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Artefact ${url} indisponible (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Charge les tampons du runtime. Le disque applicatif n'en fait PAS partie : il vit dans OPFS. */
async function loadRuntime(runtime) {
  const [wasm, bios, vgaBios, kernel, initrd, rootfs] = await Promise.all([
    fetchBytes(runtime.wasm),
    fetchBytes(runtime.bios),
    fetchBytes(runtime.vgaBios),
    fetchBytes(runtime.kernel),
    fetchBytes(runtime.initrd),
    fetchBytes(runtime.rootfs),
  ]);
  const artifacts = { wasm, bios, vgaBios, kernel, initrd, rootfs };
  const transferredBytes = Object.values(artifacts).reduce((total, a) => total + a.byteLength, 0);
  return { artifacts, transferredBytes };
}

/** Importe la classe V86 depuis l'artefact vendor déjà vérifié par empreinte. */
async function importV86(libUrl) {
  const module = await import(libUrl);
  return module.V86;
}

/** Acquiert TOUT ce qui vient du réseau : la classe V86 et les tampons du runtime. */
async function acquerirRuntime(runtime) {
  assertSchedulingApi();
  const V86 = await importV86(runtime.lib);
  const { artifacts, transferredBytes } = await loadRuntime(runtime);
  return { V86, artifacts, transferredBytes };
}

/**
 * Enregistreur de décomposition du temps de reprise (#60). Il n'INSTRUMENTE rien du boot : il pose
 * des jalons `performance.now()` que le banc lit déjà, plus quelques jalons repérés dans le flux
 * série BRUT du guest (`onSerial`). Chaque jalon horodate un événement RÉELLEMENT observé ; un jalon
 * jamais vu reste `null` et n'est pas inventé. Les repères série sont exactement les lignes que
 * `guest-init.sh` imprime sur la console avant que le pont `@VLT1` ne démarre.
 */
function createBootTimeline() {
  const REPERES_SERIE = [
    ["montageDisqueApp", "[init] montage du disque applicatif"],
    ["lancementApp", "[init] lancement de l'application"],
    ["pontSerieActif", "[init] pont serie actif"],
  ];
  const jalons = new Map();
  let tampon = "";
  let premierOctet = null;
  let dmesgDernierSec = null;

  const noter = (cle) => {
    if (!jalons.has(cle)) jalons.set(cle, performance.now());
  };

  return {
    /** Jalon posé côté hôte (entrée du boot, runtime prêt, boot rendu, santé, invariant). */
    marquer: noter,
    /** Fragment de série brut : repère les lignes d'init et le dernier horodatage dmesg du noyau. */
    ingererSerie(fragment) {
      if (fragment.length === 0) return;
      if (premierOctet === null) premierOctet = performance.now();
      // On garde une fenêtre glissante bornée : un repère tient sur une seule ligne.
      tampon = (tampon + fragment).slice(-4096);
      for (const [cle, aiguille] of REPERES_SERIE) {
        if (!jalons.has(cle) && tampon.includes(aiguille)) noter(cle);
      }
      const horodatages = tampon.match(/\[\s*(\d+\.\d+)\]/g);
      if (horodatages) {
        const dernier = Number.parseFloat(
          horodatages[horodatages.length - 1].replace(/[[\]]/g, ""),
        );
        if (Number.isFinite(dernier)) dmesgDernierSec = dernier;
      }
    },
    /**
     * Décomposition finale. Les durées sont en millisecondes, arrondies, relatives au jalon indiqué.
     * `healthMs` reste la mesure publiée (fenêtre de `awaitHealth`) ; les autres l'éclairent.
     */
    decomposer({ healthMs }) {
      const t = (cle) => jalons.get(cle) ?? null;
      const octet = premierOctet;
      const delta = (a, b) => (a === null || b === null ? null : Number((b - a).toFixed(0)));
      return {
        acquisitionRuntimeMs: delta(t("debut"), t("runtimePret")),
        initEmulateurMs: delta(t("runtimePret"), t("bootRendu")),
        premierOctetSerieMs: delta(t("bootRendu"), octet),
        noyauVersMontageMs: delta(octet, t("montageDisqueApp")),
        montageVersLancementMs: delta(t("montageDisqueApp"), t("lancementApp")),
        lancementVersPontMs: delta(t("lancementApp"), t("pontSerieActif")),
        pontVersSanteMs: delta(t("pontSerieActif"), t("santePrete")),
        healthMs,
        invariantMs: delta(t("santePrete"), t("invariantRendu")),
        noyauDmesgDernierSec: dmesgDernierSec,
      };
    },
  };
}

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
  const backend = await openOpfsVolume({ name: volume, size: appDiskBytes, journal });
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
  // Dernier geste : le volume devient identifié, donc ouvrable en écriture.
  await writeVolumeManifest(
    volume,
    createManifest({
      runtime: manifest.runtime,
      app: manifest.app,
      volumeSize: appDiskBytes,
      identity: { algorithm: "sha-256", digest: null },
    }),
  );
  return {
    phase: "prepare",
    volume,
    bytesWritten: offset,
    counts: journal.counts(),
    identified: identites,
  };
}

/**
 * Ouvre le volume OPFS, boote Rails dessus, attend `/vault/health`, vérifie l'invariant et rend le
 * compte rendu. Le seul boot possible est un boot à froid complet : il n'existe aucun chemin
 * d'instantané mémoire dans ce Worker.
 *
 * `runtimeBundle` permet de fournir un runtime DÉJÀ acquis (reprise hors ligne : l'acquisition a eu
 * lieu en ligne, le boot a lieu réseau coupé).
 */
async function bootEtVerifier({
  phase,
  volume,
  cmdline,
  memoryBytes,
  runtime,
  runtimeBundle = null,
  manifest,
  expected,
  bootTimeoutMs,
}) {
  // `SEC-UPDATE-001` : le volume est ouvert EN ÉCRITURE pour le guest. Son identité et sa
  // compatibilité sont donc exigées AVANT le premier octet — un volume sans manifeste (restauration
  // interrompue, préparation incomplète) est refusé ici, pas découvert par Rails sur un système de
  // fichiers tronqué.
  const attentes = attentesDe(manifest);
  // La décomposition (#60) pose ses jalons DÈS l'entrée, pour dater aussi l'acquisition du runtime.
  const timeline = createBootTimeline();
  timeline.marquer("debut");
  const { V86, artifacts, transferredBytes } = runtimeBundle ?? (await acquerirRuntime(runtime));
  timeline.marquer("runtimePret");
  const onlineAuBoot = navigator.onLine;

  const journal = new BlockJournal();
  const failures = [];
  const backend = await openVolumeForWrite({ name: volume, journal, expectations: attentes });
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const guestLog = [];
  const session = createReferenceGuestSession({
    V86,
    artifacts,
    appAdapter: adapter,
    journal,
    cmdline,
    memoryBytes,
    onJournal: (ligne) => {
      if (guestLog.length < 200) guestLog.push(ligne);
    },
    onSerial: (fragment) => timeline.ingererSerie(fragment),
  });

  const started = performance.now();
  let health;
  let invariant;
  try {
    await session.boot();
    timeline.marquer("bootRendu");
    health = await session.awaitHealth({ totalTimeoutMs: bootTimeoutMs });
    timeline.marquer("santePrete");
    const reponse = await session.request("GET", "/vault/invariant");
    timeline.marquer("invariantRendu");
    invariant = {
      statut: reponse.statut,
      verdict: JSON.parse(new TextDecoder().decode(reponse.corps)),
    };
  } finally {
    session.stop();
    await backend.close();
  }

  const observed = invariant.verdict.observed ?? {};
  const conforming =
    invariant.statut === 200 &&
    invariant.verdict.status === "conforming" &&
    observed.record?.id === expected.recordId &&
    observed.attachment?.sha256 === expected.attachmentSha256;

  return {
    phase,
    volume,
    volumeBytes: backend.size?.() ?? null,
    bootMilliseconds: Number((performance.now() - started).toFixed(1)),
    healthMilliseconds: health.durationMs,
    timeline: timeline.decomposer({ healthMs: health.durationMs }),
    transferredBytes,
    memoryBytes,
    usedSnapshot: false,
    online: onlineAuBoot,
    sante: health.sante,
    invariantStatus: invariant.verdict.status,
    invariantHttpStatus: invariant.statut,
    observedRecordId: observed.record?.id ?? null,
    observedAttachmentSha256: observed.attachment?.sha256 ?? null,
    conforming,
    counts: journal.counts(),
    failures,
    guestLog,
  };
}

async function phaseLive(options) {
  return bootEtVerifier({ ...options, phase: "live" });
}

async function phaseResume(options) {
  return bootEtVerifier({ ...options, phase: "resume" });
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
  await writeVolumeManifest(
    volume,
    createManifest({
      runtime: manifest.runtime,
      app: manifest.app,
      volumeSize: appDiskBytes,
      identity: { algorithm: "sha-256", digest: null },
    }),
  );
  return { phase: "prepare-empty", volume, appDiskBytes };
}

/** Retire un volume OPFS ET son manifeste voisin : rend le profil réellement « neuf ». */
async function phaseCleanup({ volume }) {
  const retire = await removeOpfsVolume(volume);
  const manifesteRetire = await revokeVolumeManifest(volume);
  return { phase: "cleanup", volume, removed: retire, manifestRemoved: manifesteRetire };
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
 * EXPORTE le volume applicatif OPFS (#11) vers une ARCHIVE OPFS, en flux. La source est lue via le
 * handle exclusif de #6 (aucun autre écrivain dans l'origine) : c'est le point cohérent déclaré. La
 * plus grande lecture est mesurée — un export à surmémoire bornée ne demande jamais tout le volume
 * d'un coup — et l'archive est écrite dans un fichier OPFS distinct, jamais tenue en RAM.
 */
async function phaseExportVolume({ volume, archive, manifest, blockBytes = EXPORT_BLOCK_BYTES }) {
  await removeOpfsVolume(archive);
  const backend = await openOpfsVolume({ name: volume, journal: new BlockJournal() });
  const base = backendSource(backend);
  const compteur = { maxLecture: 0, blocs: 0 };
  const source = {
    size: base.size,
    read(offset, length) {
      compteur.maxLecture = Math.max(compteur.maxLecture, length);
      compteur.blocs += 1;
      return base.read(offset, length);
    },
  };

  const handle = await openOpfsSyncAccess(archive);
  const sink = {
    offset: 0,
    write(bytes) {
      const written = handle.write(bytes, { at: this.offset });
      if (written !== bytes.byteLength) {
        throw new Error(`Écriture d'archive courte : ${written}/${bytes.byteLength} octet(s).`);
      }
      this.offset += written;
    },
  };

  let result;
  try {
    const m = createManifest({
      runtime: manifest.runtime,
      app: manifest.app,
      volumeSize: source.size,
      identity: { algorithm: "sha-256", digest: null },
    });
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
    handle.flush();
  } finally {
    handle.close();
    await backend.close();
  }

  return {
    phase: "export",
    volume,
    archive,
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
  return {
    phase: "inspect-volume",
    volume,
    present: etat.present,
    size: etat.size,
    manifestPresent: manifeste.present && manifeste.size > 0,
    manifestSize: manifeste.size,
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
        error: { name: error.name, code: error.code ?? null, message: error.message },
      }),
  );
});
