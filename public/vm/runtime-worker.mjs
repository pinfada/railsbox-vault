// Worker runtime du spike #4 : v86 et son backend de blocs vivent ici, conformément à l'ADR 0002.
// Le document n'obtient jamais l'émulateur ni le backend — il reçoit un compte rendu.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import {
  BARRIER_STEPS,
  FILESYSTEM_STEPS,
  GUEST_MARKER,
  GUEST_MARKER_OFFSET,
  HOST_MARKER,
  HOST_MARKER_OFFSET,
  OPFS_PERSISTENCE_STEPS,
  runSteps,
  summariseSteps,
  verdictForBarrierScenario,
} from "/src/vm/guest-scenarios.mjs";
import { createGuestSession } from "/src/vm/guest-session.mjs";
import { openMemoryVolume } from "/src/vm/memory-block-backend.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import {
  controlerContexteCourant,
  executerSousGarde,
  exigerContexteExecutable,
  mesurerRythme,
} from "/src/vm/runtime-environment.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { BRIDGE_MODES } from "/src/vm/v86-flush-bridge.mjs";

const ARTIFACTS = "/vendor/v86/artefacts/";
const SCENARIOS = { barrier: BARRIER_STEPS, filesystem: FILESYSTEM_STEPS };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Le contexte est contrôlé AVANT toute construction d'émulateur, et son refus porte un code de
 * `src/vm/runtime-errors.mjs`. C'est la réponse au symptôme central de #52 : sous la CSP de la
 * coquille, v86 privé de boucle d'ordonnancement ne bat jamais, sans lever la moindre exception.
 *
 * Le chien de garde du premier tour complète le contrôle : il attrape les pannes que celui-ci n'a
 * pas su prédire, au lieu de laisser le délai de garde du guest les attribuer à un guest lent.
 *
 * Ici, `session.boot()` de `guest-session.mjs` attend l'INVITE du guest : la garde couvre donc
 * toute l'attente utile. Sur le chemin de l'image de référence, où `boot()` rend la main bien plus
 * tôt, la garde couvre une phase plus large — voir `reference-worker-boot.mjs`.
 *
 * Il rend AUSSI le rythme observé de la boucle sur la fenêtre du boot. C'est la mesure qui permet
 * de comparer deux exécutions de l'émulateur (#74) : une durée de boot seule ne dirait pas si
 * l'émulateur a tourné plus vite ou si le guest a eu moins à faire. Le compteur est cumulé depuis
 * la construction de l'émulateur, donc quelques tours avant `run()` entrent dans la fenêtre — sur
 * des milliers de tours, l'écart est sous la résolution de l'instrument.
 *
 * @param {object} session
 * @param {Record<string, unknown>[]} observations recueille les observations non fatales de la garde
 * @returns {Promise<{ bootMilliseconds: number, rythme: Record<string, number | null> }>}
 */
async function booter(session, observations) {
  const ecouleMs = await executerSousGarde(
    () => session.ticks(),
    () => session.boot(),
    {
      onObservation: (observation) => observations.push(observation),
    },
  );
  return {
    bootMilliseconds: Number(ecouleMs.toFixed(1)),
    rythme: mesurerRythme({ ticks: session.ticks(), fenetreMs: ecouleMs }),
  };
}

let volumeCounter = 0;

async function fetchBytes(name) {
  const response = await fetch(`${ARTIFACTS}${name}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Artefact ${name} indisponible (${response.status}). Exécuter « npm run vm:fetch ».`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function loadArtifacts() {
  const [wasm, bios, vgaBios, cdrom] = await Promise.all([
    fetchBytes("v86.wasm"),
    fetchBytes("seabios.bin"),
    fetchBytes("vgabios.bin"),
    fetchBytes("linux4.iso"),
  ]);
  return {
    artifacts: { wasm, bios, vgaBios, cdrom },
    transferredBytes: wasm.byteLength + bios.byteLength + vgaBios.byteLength + cdrom.byteLength,
  };
}

async function run({
  scenario = "barrier",
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 5,
}) {
  const steps = SCENARIOS[scenario];
  if (!steps) throw new Error(`Scénario inconnu : ${scenario}`);
  await exigerContexteExecutable();

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();

  volumeCounter += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `worker-${volumeCounter}`,
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay,
  });
  const failures = [];
  const observations = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });

  try {
    const { bootMilliseconds, rythme } = await booter(session, observations);
    const results = await runSteps(session, steps);
    const verdict = verdictForBarrierScenario(journal);
    return {
      scenario,
      mode,
      bootMilliseconds,
      rythme,
      transferredBytes,
      counts: journal.counts(),
      steps: summariseSteps(journal, results),
      verdict,
      failures,
      observationsRuntime: observations,
      crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
    };
  } finally {
    session.stop();
    await backend.close();
  }
}

/**
 * Preuve de persistance de bout en bout (#6) : un vrai guest Linux lit une marque écrite par
 * l'hôte dans le fichier OPFS, écrit la sienne, la synchronise ; l'hôte ferme alors le handle,
 * rouvre le volume et vérifie que les octets du guest sont bien dans le fichier.
 *
 * Deux directions, parce qu'une seule ne prouverait qu'une moitié : que le guest voie le support
 * n'implique pas que ses écritures y atterrissent, et l'inverse non plus.
 */
async function runOpfsPersistence({
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 0,
  volume = "guest-persistance",
}) {
  await exigerContexteExecutable();

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();

  await removeOpfsVolume(volume);
  const journal = new BlockJournal();
  const backend = await openOpfsVolume({
    name: volume,
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay,
  });

  // La marque de l'hôte est déposée AVANT le boot : ce que le guest lira vient du fichier OPFS et
  // d'aucun tampon intermédiaire.
  await backend.write(HOST_MARKER_OFFSET, encoder.encode(HOST_MARKER));
  await backend.flush();

  const failures = [];
  const observations = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });

  let boot;
  let results;
  try {
    boot = await booter(session, observations);
    results = await runSteps(session, OPFS_PERSISTENCE_STEPS);
  } finally {
    session.stop();
    await backend.close();
  }

  // Handle fermé, volume rouvert sans géométrie déclarée : la relecture porte sur le fichier.
  // Le `finally` n'est pas décoratif : sans lui, une lecture qui échoue laisserait le handle
  // exclusif ouvert et l'exécution suivante rougirait sur `VAULT_STORAGE_BUSY`, en masquant la
  // cause réelle.
  const reopened = await openOpfsVolume({ name: volume, journal: new BlockJournal() });
  let guestBytes;
  let hostBytes;
  let reopenedSize;
  try {
    guestBytes = await reopened.read(GUEST_MARKER_OFFSET, GUEST_MARKER.length);
    hostBytes = await reopened.read(HOST_MARKER_OFFSET, HOST_MARKER.length);
    reopenedSize = reopened.size();
  } finally {
    await reopened.close();
  }

  const steps = summariseSteps(journal, results);
  const stepOutput = (label) => steps.find((step) => step.label === label)?.output ?? null;

  return {
    scenario: "opfs-persistence",
    mode,
    volume,
    volumeBytes,
    reopenedSize,
    bootMilliseconds: boot.bootMilliseconds,
    rythme: boot.rythme,
    transferredBytes,
    counts: journal.counts(),
    steps,
    verdict: verdictForBarrierScenario(journal),
    expected: { hostMarker: HOST_MARKER, guestMarker: GUEST_MARKER },
    guestReadOfHostMarker: stepOutput("lire-marque-hote"),
    guestReadOfOwnMarker: stepOutput("relire-marque-guest"),
    hostReadOfGuestMarker: decoder.decode(guestBytes),
    hostReadOfHostMarker: decoder.decode(hostBytes),
    failures,
    observationsRuntime: observations,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
  };
}

/**
 * Barrière durable de bout en bout sur le backend OPFS (#14, `SEC-DURABLE-001`). Un vrai guest écrit
 * puis `fsync` sur un disque IDE adossé au backend OPFS ; la mesure porte sur la CHAÎNE causale
 * write → flush(OPFS réel) → acquittement, et sur les deux écarts qui la rendraient fausse :
 *
 *  - `flushDelay > 0` retarde la barrière du support. Le guest reste occupé (BSY) jusqu'à sa
 *    résolution — le rapport le montre par un ordre `flush` avant `flush-ack` maintenu, jamais
 *    inversé ;
 *  - `fault` (une valeur de `FAULT_KINDS` sur l'opération `flush`) fait échouer la barrière. La
 *    commande ATA est alors ABANDONNÉE : le guest reçoit une erreur d'E/S, la coquille une erreur
 *    typée dans `failures`, et AUCUN `flush-ack` n'est inventé.
 */
async function runOpfsBarrier({
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 0,
  fault = null,
  volume = "guest-barriere",
}) {
  await exigerContexteExecutable();

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();

  await removeOpfsVolume(volume);
  const journal = new BlockJournal();
  const faults = fault
    ? createFaultPlan([{ kind: fault, operation: "flush", occurrence: 1 }])
    : createFaultPlan();
  const backend = await openOpfsVolume({
    name: volume,
    size: volumeBytes,
    journal,
    faults,
    flushDelay,
  });

  const failures = [];
  const observations = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });

  let boot;
  let results;
  try {
    boot = await booter(session, observations);
    results = await runSteps(session, BARRIER_STEPS);
  } finally {
    session.stop();
    await backend.close();
  }

  return {
    scenario: "opfs-barrier",
    mode,
    volume,
    volumeBytes,
    flushDelay,
    fault,
    bootMilliseconds: boot.bootMilliseconds,
    rythme: boot.rythme,
    transferredBytes,
    counts: journal.counts(),
    steps: summariseSteps(journal, results),
    verdict: verdictForBarrierScenario(journal),
    faultsFired: faults.fired(),
    faultsUnfired: faults.unfired(),
    failures,
    observationsRuntime: observations,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
  };
}

const OPFS_SCENARIOS = new Map([
  ["opfs-persistence", runOpfsPersistence],
  ["opfs-barrier", runOpfsBarrier],
]);

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  // Le diagnostic est interrogeable SANS démarrer d'émulateur ni charger un seul artefact. C'est ce
  // qui permet de l'éprouver sur les trois moteurs dans `npm run check`, qui n'a pas de préalable
  // réseau — et à une coquille de savoir, avant d'ouvrir un volume, si ce contexte peut exécuter le
  // runtime.
  if (type === "controler") {
    controlerContexteCourant().then(
      (erreur) =>
        self.postMessage({
          id,
          ok: true,
          report: {
            url: location.href,
            schedulerPostTask: typeof globalThis.scheduler?.postTask === "function",
            diagnostic: erreur ? erreur.toJSON() : null,
          },
        }),
      (erreur) => self.postMessage({ id, ok: false, error: { message: erreur.message } }),
    );
    return;
  }
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  const options = payload ?? {};
  const opfsRunner = OPFS_SCENARIOS.get(options.scenario);
  const execute = opfsRunner ? opfsRunner(options) : run(options);
  execute.then(
    (report) => self.postMessage({ id, ok: true, report }),
    // Une erreur TYPÉE traverse le port avec son code ET son contexte : la coquille doit pouvoir
    // distinguer « la CSP refuse WebAssembly » de « le Worker imbriqué est mort » sans lire un
    // message. `toJSON()` est le contrat commun de `StorageError` et de `RuntimeError`.
    (error) =>
      self.postMessage({
        id,
        ok: false,
        error:
          typeof error.toJSON === "function"
            ? error.toJSON()
            : { name: error.name, code: error.code ?? null, message: error.message },
      }),
  );
});
