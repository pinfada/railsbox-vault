/**
 * Mesures exécutées dans la page servie par `tools/serve.mjs`, y compris le dialogue avec le
 * Worker dédié. Le rapport produit est sérialisable en JSON et ne contient aucune donnée
 * personnelle : agent utilisateur, plateforme déclarée et verdicts techniques uniquement.
 */

import {
  CAPABILITIES,
  CAPABILITY_PROBE_CONTRACT,
  computeVaultVerdict,
} from "./capability-contract.mjs";
import { probeAesGcm, probeHkdf } from "./crypto-probes.mjs";
import {
  detectPlatformAuthenticatorPresence,
  detectPublicKeyCredential,
  isConstructorLike,
} from "./host-api.mjs";
import {
  DeniedCapabilityError,
  MissingCapabilityError,
  ProbeTimeoutError,
  deniedIfRefused,
  measureCapability,
  unmeasuredCapability,
  withTimeout,
} from "./probe-runner.mjs";
import { MINIMAL_WASM_EXPECTATION, MINIMAL_WASM_MODULE } from "./probe-vectors.mjs";

const WORKER_HANDSHAKE_TIMEOUT_MS = 30_000;
const CHANNEL_TIMEOUT_MS = 5_000;
const PERSIST_DECISION_TIMEOUT_MS = 4_000;

let uniqueCounter = 0;

function uniqueName(prefix) {
  uniqueCounter += 1;
  return `railsbox-vault-compat-${prefix}-${Date.now()}-${uniqueCounter}`;
}

function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "inconnu";
  return `${Math.round(value / (1024 * 1024))} Mio`;
}

async function requestWorkerCapabilities(workerUrl) {
  if (!isConstructorLike(globalThis.Worker)) {
    throw new MissingCapabilityError(
      `l'objet d'interface Worker n'est pas exposé (typeof ${typeof globalThis.Worker})`,
    );
  }

  const worker = new Worker(workerUrl, { type: "module" });
  try {
    const answer = new Promise((resolve, reject) => {
      worker.addEventListener("message", (event) => resolve(event.data), { once: true });
      worker.addEventListener(
        "messageerror",
        () => reject(new Error("message du Worker non désérialisable")),
        { once: true },
      );
      worker.addEventListener(
        "error",
        (event) => reject(new Error(`erreur du Worker : ${event.message ?? "inconnue"}`)),
        { once: true },
      );
    });

    worker.postMessage({ type: "probe-request", contract: CAPABILITY_PROBE_CONTRACT });
    const message = await withTimeout(
      answer,
      WORKER_HANDSHAKE_TIMEOUT_MS,
      "le Worker n'a pas répondu dans le délai imparti",
    );

    if (
      message?.type !== "probe-result" ||
      message?.contract?.id !== CAPABILITY_PROBE_CONTRACT.id ||
      message?.contract?.version !== CAPABILITY_PROBE_CONTRACT.version ||
      !Array.isArray(message.capabilities)
    ) {
      throw new Error("réponse du Worker hors contrat");
    }
    return message.capabilities;
  } finally {
    worker.terminate();
  }
}

/** Décrit précisément ce qui manque plutôt que de conclure globalement à « pas de stockage ». */
function requireStorageManager(member) {
  if (!navigator.storage) {
    throw new MissingCapabilityError("navigator.storage n'est pas exposé par ce moteur");
  }
  if (typeof navigator.storage[member] !== "function") {
    throw new MissingCapabilityError(`navigator.storage.${member} est absent`);
  }
  return navigator.storage;
}

async function persistentStoragePermissionState() {
  if (typeof navigator.permissions?.query !== "function") return "inconnu";
  try {
    const status = await navigator.permissions.query({ name: "persistent-storage" });
    return status.state;
  } catch (error) {
    return `non interrogeable (${error.name})`;
  }
}

async function probeOpfsRoot() {
  requireStorageManager("getDirectory");
  try {
    const root = await navigator.storage.getDirectory();
    if (typeof root?.getFileHandle !== "function") {
      throw new Error("la racine OPFS ne propose pas getFileHandle");
    }
    return "racine OPFS obtenue et exploitable depuis la page";
  } catch (error) {
    throw deniedIfRefused(error);
  }
}

async function probeStorageEstimate() {
  requireStorageManager("estimate");
  const estimate = await navigator.storage.estimate();
  if (typeof estimate?.quota !== "number") {
    throw new Error("estimate() ne renvoie pas de quota numérique");
  }
  return `quota ${formatBytes(estimate.quota)}, usage ${formatBytes(estimate.usage ?? 0)}`;
}

async function probeStoragePersistence() {
  requireStorageManager("persisted");
  requireStorageManager("persist");

  if (await navigator.storage.persisted()) {
    return "stockage déjà déclaré persistant";
  }

  const permission = await persistentStoragePermissionState();
  let granted;
  try {
    granted = await withTimeout(
      navigator.storage.persist(),
      PERSIST_DECISION_TIMEOUT_MS,
      "aucune décision rendue sur la demande de persistance",
    );
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      // Firefox laisse la promesse en attente derrière une invite utilisateur : sans interaction,
      // la persistance n'est pas accordée. C'est un refus documenté, pas une erreur de sonde.
      throw new DeniedCapabilityError(
        `demande laissée en attente d'une interaction utilisateur (autorisation « ${permission} »)`,
      );
    }
    throw deniedIfRefused(error);
  }
  if (!granted) {
    throw new DeniedCapabilityError(
      `navigator.storage.persist() a renvoyé false (autorisation « ${permission} »)`,
    );
  }
  return `persistance accordée à la demande (autorisation « ${permission} »)`;
}

async function probeWebAssembly() {
  if (typeof WebAssembly?.instantiate !== "function") {
    throw new MissingCapabilityError("WebAssembly.instantiate est absent");
  }
  const { exportName, operandA, operandB, sum } = MINIMAL_WASM_EXPECTATION;
  const { instance } = await WebAssembly.instantiate(MINIMAL_WASM_MODULE, {});
  const exported = instance.exports[exportName];
  if (typeof exported !== "function") {
    throw new Error(`export ${exportName} absent du module instancié`);
  }
  const result = exported(operandA, operandB);
  if (result !== sum) {
    throw new Error(`résultat inattendu : ${operandA}+${operandB}=${result}`);
  }
  return `module minimal instancié, ${exportName}(${operandA}, ${operandB}) = ${sum}`;
}

function probeSharedArrayBuffer() {
  if (!isConstructorLike(globalThis.SharedArrayBuffer)) {
    throw new MissingCapabilityError(
      "SharedArrayBuffer n'est pas exposé : contexte probablement non isolé",
    );
  }
  const buffer = new SharedArrayBuffer(8);
  if (buffer.byteLength !== 8) {
    throw new Error(`taille inattendue : ${buffer.byteLength}`);
  }
  return "SharedArrayBuffer de 8 octets alloué dans la page";
}

function probeCrossOriginIsolation() {
  if (typeof globalThis.crossOriginIsolated !== "boolean") {
    throw new MissingCapabilityError("crossOriginIsolated n'est pas exposé");
  }
  if (!globalThis.crossOriginIsolated) {
    throw new MissingCapabilityError("contexte non isolé : COOP/COEP absents ou non honorés");
  }
  return "contexte isolé multi-origine actif";
}

async function probeBroadcastChannel() {
  if (!isConstructorLike(globalThis.BroadcastChannel)) {
    throw new MissingCapabilityError(
      `BroadcastChannel n'est pas exposé (typeof ${typeof globalThis.BroadcastChannel})`,
    );
  }
  const name = uniqueName("channel");
  const emitter = new BroadcastChannel(name);
  const receiver = new BroadcastChannel(name);
  try {
    const received = new Promise((resolve) => {
      receiver.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    emitter.postMessage("ping");
    const value = await withTimeout(
      received,
      CHANNEL_TIMEOUT_MS,
      "aucun message reçu sur le canal de diffusion",
    );
    if (value !== "ping") {
      throw new Error(`charge utile inattendue : ${String(value)}`);
    }
    return "message diffusé et reçu entre deux canaux de la même origine";
  } finally {
    emitter.close();
    receiver.close();
  }
}

async function probeWebLocks() {
  if (typeof navigator.locks?.request !== "function") {
    throw new MissingCapabilityError("navigator.locks est absent");
  }
  const name = uniqueName("lock");
  const held = await navigator.locks.request(name, (lock) => lock?.name === name);
  if (!held) {
    throw new Error("le verrou obtenu ne porte pas le nom demandé");
  }
  return "verrou exclusif acquis puis relâché";
}

function probePerformanceMemory() {
  const memory = globalThis.performance?.memory;
  if (!memory) {
    throw new MissingCapabilityError(
      "performance.memory n'est pas exposé : extension propre à Chromium",
    );
  }
  if (typeof memory.jsHeapSizeLimit !== "number") {
    throw new Error("performance.memory n'expose pas jsHeapSizeLimit");
  }
  return `limite de tas JS ${formatBytes(memory.jsHeapSizeLimit)}`;
}

const PAGE_PROBES = new Map([
  ["webCryptoAesGcm", () => probeAesGcm("page")],
  ["webCryptoHkdf", () => probeHkdf("page")],
  ["opfsGetDirectory", probeOpfsRoot],
  ["storageEstimate", probeStorageEstimate],
  ["storagePersist", probeStoragePersistence],
  ["webAssembly", probeWebAssembly],
  ["sharedArrayBuffer", async () => probeSharedArrayBuffer()],
  ["crossOriginIsolated", async () => probeCrossOriginIsolation()],
  ["broadcastChannel", probeBroadcastChannel],
  ["webLocks", probeWebLocks],
  ["publicKeyCredential", async () => detectPublicKeyCredential(globalThis)],
  ["platformAuthenticatorPresence", async () => detectPlatformAuthenticatorPresence(globalThis)],
  ["performanceMemory", async () => probePerformanceMemory()],
]);

function describeAgent() {
  return {
    userAgent: navigator.userAgent,
    userAgentPlatform: navigator.userAgentData?.platform ?? null,
    hardwareConcurrency:
      typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    // Variable explicative indispensable : `navigator.storage` et WebCrypto n'existent qu'en
    // contexte sécurisé. Un verdict `unsupported` se lit différemment selon ce booléen.
    isSecureContext: globalThis.isSecureContext === true,
  };
}

function orderByMatrix(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return CAPABILITIES.map(
    (capability) =>
      byId.get(capability.id) ??
      unmeasuredCapability(
        capability.id,
        capability.context,
        "aucune mesure produite pour cette capacité",
      ),
  );
}

/** Exécute la sonde complète depuis la page et renvoie le rapport avant finalisation. */
export async function runPageProbe(workerUrl) {
  let workerCapabilities = null;
  const workerRecord = await measureCapability({
    id: "moduleDedicatedWorker",
    context: "page",
    timeoutMs: WORKER_HANDSHAKE_TIMEOUT_MS + 5_000,
    run: async () => {
      workerCapabilities = await requestWorkerCapabilities(workerUrl);
      return `Worker de type module opérationnel, ${workerCapabilities.length} mesure(s) rapatriée(s)`;
    },
  });

  const records = [workerRecord];
  for (const [id, run] of PAGE_PROBES) {
    records.push(await measureCapability({ id, context: "page", run }));
  }

  if (workerCapabilities) {
    records.push(...workerCapabilities);
  } else {
    for (const capability of CAPABILITIES.filter((entry) => entry.context === "worker")) {
      records.push(
        unmeasuredCapability(
          capability.id,
          capability.context,
          `Worker indisponible — ${workerRecord.detail}`,
        ),
      );
    }
  }

  const capabilities = orderByMatrix(records);
  return {
    contract: { ...CAPABILITY_PROBE_CONTRACT },
    generatedAt: new Date().toISOString(),
    agent: describeAgent(),
    capabilities,
    vaultVerdict: computeVaultVerdict(capabilities),
  };
}
