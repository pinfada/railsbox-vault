// Worker runtime du spike #4 : v86 et son backend de blocs vivent ici, conformément à l'ADR 0002.
// Le document n'obtient jamais l'émulateur ni le backend — il reçoit un compte rendu.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import {
  BARRIER_STEPS,
  FILESYSTEM_STEPS,
  runSteps,
  summariseSteps,
  verdictForBarrierScenario,
} from "/src/vm/guest-scenarios.mjs";
import { createGuestSession } from "/src/vm/guest-session.mjs";
import { openMemoryVolume } from "/src/vm/memory-block-backend.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";

const ARTIFACTS = "/vendor/v86/artefacts/";
const SCENARIOS = { barrier: BARRIER_STEPS, filesystem: FILESYSTEM_STEPS };

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
  durability = true,
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
  const session = createGuestSession({ V86, artifacts, adapter, journal, durability });

  try {
    const bootMilliseconds = await session.boot();
    const results = await runSteps(session, steps);
    const verdict = verdictForBarrierScenario(journal);
    return {
      scenario,
      durability,
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

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  run(payload ?? {}).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) =>
      self.postMessage({ id, ok: false, error: { name: error.name, message: error.message } }),
  );
});
