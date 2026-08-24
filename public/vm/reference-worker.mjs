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
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { createReferenceGuestSession } from "/src/vm/reference-guest-session.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";

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
async function phasePrepare({ volume, appDiskBytes, appDiskUrl }) {
  await removeOpfsVolume(volume);
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
  return { phase: "prepare", volume, bytesWritten: offset, counts: journal.counts() };
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
  expected,
  bootTimeoutMs,
}) {
  // La décomposition (#60) pose ses jalons DÈS l'entrée, pour dater aussi l'acquisition du runtime.
  const timeline = createBootTimeline();
  timeline.marquer("debut");
  const { V86, artifacts, transferredBytes } = runtimeBundle ?? (await acquerirRuntime(runtime));
  timeline.marquer("runtimePret");
  const onlineAuBoot = navigator.onLine;

  const journal = new BlockJournal();
  const failures = [];
  const backend = await openOpfsVolume({ name: volume, journal });
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
async function phasePrepareEmpty({ volume, appDiskBytes }) {
  await removeOpfsVolume(volume);
  const backend = await openOpfsVolume({
    name: volume,
    size: appDiskBytes,
    journal: new BlockJournal(),
  });
  await backend.flush();
  await backend.close();
  return { phase: "prepare-empty", volume, appDiskBytes };
}

/** Retire un volume OPFS : rend le profil réellement « neuf » entre deux exécutions. */
async function phaseCleanup({ volume }) {
  await removeOpfsVolume(volume);
  return { phase: "cleanup", volume };
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
