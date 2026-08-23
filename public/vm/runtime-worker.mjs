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
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { BRIDGE_MODES } from "/src/vm/v86-flush-bridge.mjs";

const ARTIFACTS = "/vendor/v86/artefacts/";
const SCENARIOS = { barrier: BARRIER_STEPS, filesystem: FILESYSTEM_STEPS };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * v86 choisit sa boucle d'ordonnancement à l'initialisation : `scheduler.postTask` si son URL
 * contient `use-scheduling-api`, sinon un Worker imbriqué chargé depuis une URL `blob:`. Ce second
 * chemin est refusé par la CSP de la coquille et l'émulateur ne bat alors jamais — sans erreur, ce
 * qui se lit comme un guest qui ne démarre pas. La condition est donc vérifiée AVANT le démarrage,
 * et son absence est une erreur explicite, jamais un repli silencieux.
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
  assertSchedulingApi();

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
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });

  try {
    const bootMilliseconds = await session.boot();
    const results = await runSteps(session, steps);
    const verdict = verdictForBarrierScenario(journal);
    return {
      scenario,
      mode,
      bootMilliseconds: Number(bootMilliseconds.toFixed(1)),
      transferredBytes,
      counts: journal.counts(),
      steps: summariseSteps(journal, results),
      verdict,
      failures,
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
  assertSchedulingApi();

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
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });

  let bootMilliseconds;
  let results;
  try {
    bootMilliseconds = await session.boot();
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
    bootMilliseconds: Number(bootMilliseconds.toFixed(1)),
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
    crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
  };
}

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  const options = payload ?? {};
  const execute =
    options.scenario === "opfs-persistence" ? runOpfsPersistence(options) : run(options);
  execute.then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) =>
      self.postMessage({
        id,
        ok: false,
        error: { name: error.name, code: error.code ?? null, message: error.message },
      }),
  );
});
