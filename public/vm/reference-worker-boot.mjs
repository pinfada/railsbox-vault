// Acquisition du runtime et BOOT VÉRIFIÉ du guest, extraits de `reference-worker.mjs` (#13).
//
// Ce module ne connaît que le boot : acquérir ce qui vient du réseau, ouvrir le volume EN ÉCRITURE
// par le seul chemin qui exige son identité (`SEC-UPDATE-001`), faire démarrer Rails, l'interroger,
// et rendre ce qui a été observé. Il ne décide rien : aucune phase ne se déclare « réussie »
// d'elle-même, l'assertion vit dans les spécifications de `tests/e2e/`.
//
// Il vit à part parce que le Worker de référence porte désormais quatre familles de phases —
// préparation, boot, export/restauration, migration — et que le dépôt tient ses fichiers sous
// 800 lignes. Son nom contient « worker » : la configuration ESLint en déduit le contexte
// d'exécution et ne lui accorde aucun global de page (voir `eslint.config.mjs`).

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { openVolumeForWrite } from "/src/vm/opfs-volume-open.mjs";
import { createReferenceGuestSession } from "/src/vm/reference-guest-session.mjs";
import {
  executerSousGarde,
  exigerContexteExecutable,
  mesurerRythme,
} from "/src/vm/runtime-environment.mjs";
import { decrireBoucle, installerBoucleOrdonnancement } from "/src/vm/scheduling-loop.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { createManifest } from "/src/vm/volume-manifest.mjs";

/**
 * La boucle d'ordonnancement de v86 est posée À L'ÉVALUATION de ce module — donc au démarrage du
 * Worker, avant `importV86` et avant le contrôle préalable. v86 fige son chemin d'ordonnancement à
 * l'évaluation de SON module et ne le révise jamais : posée plus tard, elle n'aurait aucun effet
 * (ADR 0013, § « Mise en œuvre par #74 »).
 */
const boucleOrdonnancement = installerBoucleOrdonnancement();

/**
 * Identités du volume, telles qu'un scénario les déclare. Elles servent DEUX fois : à inscrire le
 * manifeste quand le volume est créé, et à l'exiger quand il est rouvert en écriture.
 * `SEC-UPDATE-001` n'admet aucun volume anonyme, donc aucune phase écrivante sans descripteur.
 *
 * `supportedFormat` est facultatif et n'est PAS une capacité du produit : c'est le moyen, pour un
 * scénario, de faire tourner ce runtime avec la plage de formats d'un runtime ANTÉRIEUR et de
 * vérifier qu'un volume d'un format plus récent lui est bien refusé (#13). Le refus prouvé est
 * celui de la règle de compatibilité, pas celui d'un binaire publié plus tôt — aucune release
 * n'en a encore produit.
 */
export function attentesDe(manifest) {
  if (!manifest?.app?.id || !manifest?.runtime?.version) {
    throw new Error(
      "Descripteur de manifeste requis : un volume ne s'ouvre en écriture que s'il est identifié (SEC-UPDATE-001).",
    );
  }
  const attentes = {
    app: { id: manifest.app.id },
    runtime: { version: manifest.runtime.version },
  };
  if (manifest.supportedFormat) attentes.supportedFormat = manifest.supportedFormat;
  return attentes;
}

/**
 * Construit le manifeste qu'une phase de CRÉATION inscrit. Le descripteur porte le format visé : un
 * scénario de migration doit pouvoir fabriquer un volume au format ANTÉRIEUR, sans quoi il n'aurait
 * rien à migrer. Sans indication, le format courant du runtime s'applique.
 */
export function manifesteDuDescripteur(manifest, volumeSize) {
  return createManifest({
    ...(Number.isInteger(manifest.formatVersion) ? { formatVersion: manifest.formatVersion } : {}),
    runtime: manifest.runtime,
    app: manifest.app,
    volumeSize,
    identity: { algorithm: "sha-256", digest: null },
  });
}

/**
 * Le contexte est contrôlé AVANT toute construction d'émulateur, et son refus porte un code de
 * `src/vm/runtime-errors.mjs` (#52). Sans ce contrôle, un contexte privé de boucle d'ordonnancement
 * ne produirait aucune exception : l'émulateur ne battrait simplement jamais.
 *
 * La garde du premier tour couvre ici DEUX phases, et c'est le point délicat de ce chemin :
 * `createReferenceGuestSession.boot()` rend la main juste après `emulator.run()`, avant que le
 * guest ait dit quoi que ce soit. Une garde arrêtée là n'aurait pas eu le temps de prendre deux
 * échantillons, et un émulateur qui ne bat pas serait retombé sur `awaitHealth`, dont l'expiration
 * accuse le GUEST — exactement la cause fausse que #52 combat. La garde couvre donc le boot ET
 * l'attente de santé, et rend le compte rendu de cette dernière.
 */
function booterEtAttendreSante(session, { bootTimeoutMs, timeline, observations }) {
  return executerSousGarde(
    () => session.ticks(),
    async () => {
      await session.boot();
      timeline.marquer("bootRendu");
      return session.awaitHealth({ totalTimeoutMs: bootTimeoutMs });
    },
    {
      onObservation: (observation) => observations.push(observation),
      decrireBoucle: () => decrireBoucle(boucleOrdonnancement),
    },
  );
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
export async function acquerirRuntime(runtime) {
  await exigerContexteExecutable();
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
 * Ouvre le volume OPFS, boote Rails dessus, attend `/vault/health`, vérifie l'invariant et rend le
 * compte rendu. Le seul boot possible est un boot à froid complet : il n'existe aucun chemin
 * d'instantané mémoire dans ce Worker.
 *
 * `runtimeBundle` permet de fournir un runtime DÉJÀ acquis (reprise hors ligne : l'acquisition a eu
 * lieu en ligne, le boot a lieu réseau coupé).
 */
export async function bootEtVerifier({
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
  // ou migration interrompue, préparation incomplète), d'un format antérieur non migré ou d'un
  // format plus récent que ce runtime est refusé ici, pas découvert par Rails sur un système de
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
  const observations = [];
  let health;
  let invariant;
  let rythme;
  let boucle;
  try {
    health = await booterEtAttendreSante(session, { bootTimeoutMs, timeline, observations });
    timeline.marquer("santePrete");
    // Rythme de la boucle sur la fenêtre boot → santé de Rails. C'est l'instrument qui rend
    // comparables deux exécutions de l'IMAGE DE RÉFÉRENCE avec des boucles d'ordonnancement
    // différentes (#74) : `healthMilliseconds` seul ne dirait pas si l'émulateur a battu plus vite.
    rythme = mesurerRythme({ ticks: session.ticks(), fenetreMs: performance.now() - started });
    boucle = decrireBoucle(boucleOrdonnancement);
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
    rythme,
    boucleOrdonnancement: boucle,
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
    observationsRuntime: observations,
    guestLog,
  };
}
