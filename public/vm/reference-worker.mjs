// Worker runtime de la preuve de reprise (#7). C'est le SEUL contexte autorisé à ouvrir le handle
// exclusif OPFS et à porter v86 (ADR 0002) : la coquille ne reçoit que des données JSON.
//
// Trois phases, appelées chacune dans un Worker NEUF par le test E2E, pour que « fermer page +
// Worker + handles » soit réel entre elles :
//
//   prepare  volume OPFS neuf, le disque applicatif de l'image #5 y est écrit puis flushé.
//   live     Rails boote sur ce disque OPFS en écriture ; ses écritures traversent le pont de
//            durabilité jusqu'à OPFS ; l'invariant est vérifié à chaud.
//   resume   BOOT À FROID depuis le même volume OPFS (aucun snapshot), invariant revérifié.
//
// Aucune phase ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et
// l'assertion vit dans `tests/e2e/reprise-mutation-boot-froid.spec.mjs`.

import { BlockJournal, JOURNAL_OPERATIONS } from "/src/vm/block-journal.mjs";
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

/** Empreinte SHA-256 d'un ensemble de régions, cadrée par (offset, longueur) pour être sans
 * ambiguïté. Sert à prouver que des OCTETS écrits par Rails se retrouvent à l'identique après un
 * boot à froid — au-delà de l'invariant, qui ne couvre que l'enregistrement et sa pièce jointe. */
async function digestRegions(backend, regions) {
  const parts = [];
  for (const { offset, length } of regions) {
    const cadre = new Uint8Array(16);
    const vue = new DataView(cadre.buffer);
    vue.setBigUint64(0, BigInt(offset));
    vue.setBigUint64(8, BigInt(length));
    parts.push(cadre, await backend.read(offset, length));
  }
  const total = parts.reduce((somme, p) => somme + p.byteLength, 0);
  const tampon = new Uint8Array(total);
  let position = 0;
  for (const p of parts) {
    tampon.set(p, position);
    position += p.byteLength;
  }
  const empreinte = await crypto.subtle.digest("SHA-256", tampon);
  return [...new Uint8Array(empreinte)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Régions distinctes écrites pendant une session, dans l'ordre où elles ont été journalisées. */
function regionsEcrites(journal) {
  const vues = new Set();
  const regions = [];
  for (const entree of journal.entries()) {
    if (entree.operation !== JOURNAL_OPERATIONS.write) continue;
    const cle = `${entree.offset}:${entree.length}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    regions.push({ offset: entree.offset, length: entree.length });
  }
  return regions;
}

/** Attend que l'adaptateur ait drainé ses écritures en vol avant toute relecture du volume. */
async function drainerAdaptateur(adapter, delaiMs = 3000) {
  const debut = Date.now();
  while (adapter.status().inFlight > 0 && Date.now() - debut < delaiMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Ouvre le volume OPFS, boote Rails dessus, attend `/vault/health`, vérifie l'invariant et rend le
 * compte rendu. Le seul boot possible est un boot à froid complet : il n'existe aucun chemin
 * d'instantané mémoire dans ce Worker.
 *
 * `runtimeBundle` permet de fournir un runtime DÉJÀ acquis (reprise hors ligne : l'acquisition a eu
 * lieu en ligne, le boot a lieu réseau coupé). `checkRegions`, si fourni, est relu AVANT le boot :
 * l'empreinte rendue porte donc sur l'état laissé par la session précédente, intact.
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
  captureWrites = false,
  checkRegions = null,
}) {
  const { V86, artifacts, transferredBytes } = runtimeBundle ?? (await acquerirRuntime(runtime));
  const onlineAuBoot = navigator.onLine;

  // Relecture AVANT boot : elle capture l'état exact laissé par la session précédente, avant que le
  // Rails de cette session-ci n'écrive quoi que ce soit. C'est ce qui rend la comparaison honnête.
  let preBootRegionsDigest = null;
  if (checkRegions && checkRegions.length > 0) {
    const verif = await openOpfsVolume({ name: volume, journal: new BlockJournal() });
    try {
      preBootRegionsDigest = await digestRegions(verif, checkRegions);
    } finally {
      await verif.close();
    }
  }

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
  });

  const started = performance.now();
  let health;
  let invariant;
  let writtenRegions = null;
  let writtenRegionsDigest = null;
  try {
    await session.boot();
    health = await session.awaitHealth({ totalTimeoutMs: bootTimeoutMs });
    const reponse = await session.request("GET", "/vault/invariant");
    invariant = {
      statut: reponse.statut,
      verdict: JSON.parse(new TextDecoder().decode(reponse.corps)),
    };
    if (captureWrites) {
      session.stop();
      await drainerAdaptateur(adapter);
      writtenRegions = regionsEcrites(journal);
      writtenRegionsDigest = await digestRegions(backend, writtenRegions);
    }
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
    writtenRegions,
    writtenRegionsDigest,
    preBootRegionsDigest,
    failures,
    guestLog,
  };
}

async function phaseLive(options) {
  return bootEtVerifier({ ...options, phase: "live", captureWrites: true });
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
