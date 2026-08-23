/**
 * Mesures exécutées dans un Worker dédié de type module : WebCrypto, accès synchrone OPFS et
 * blocage `Atomics.wait`. Le fichier temporaire OPFS est toujours supprimé, y compris après un
 * échec, et un nettoyage incomplet est signalé plutôt que masqué.
 */

import { probeAesGcm } from "./crypto-probes.mjs";
import { isConstructorLike } from "./host-api.mjs";
import { MissingCapabilityError, deniedIfRefused, measureCapability } from "./probe-runner.mjs";
import { AES_GCM_VECTOR, bytesToHex, hexToBytes } from "./probe-vectors.mjs";

const PROBE_DIRECTORY = "railsbox-vault-compat";
const TRUNCATED_SIZE = 4;

async function exerciseSyncAccessHandle(fileHandle) {
  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new MissingCapabilityError("createSyncAccessHandle n'est pas exposé sur le fichier OPFS");
  }

  const handle = await fileHandle.createSyncAccessHandle();
  try {
    const payload = hexToBytes(AES_GCM_VECTOR.ciphertextHex);
    const written = handle.write(payload, { at: 0 });
    handle.flush();
    if (written !== payload.length) {
      throw new Error(`écriture partielle : ${written}/${payload.length} octets`);
    }

    const size = handle.getSize();
    if (size !== payload.length) {
      throw new Error(`taille inattendue après écriture : ${size}`);
    }

    const readBack = new Uint8Array(payload.length);
    const read = handle.read(readBack, { at: 0 });
    if (read !== payload.length || bytesToHex(readBack) !== AES_GCM_VECTOR.ciphertextHex) {
      throw new Error("la relecture ne restitue pas les octets écrits");
    }

    handle.truncate(TRUNCATED_SIZE);
    const truncated = handle.getSize();
    if (truncated !== TRUNCATED_SIZE) {
      throw new Error(`troncature inopérante : ${truncated} octets restants`);
    }

    return `write/flush/read/truncate/close vérifiés sur ${payload.length} octets`;
  } finally {
    handle.close();
  }
}

async function removeProbeArtefacts(root, directory, fileName) {
  const problems = [];
  try {
    await directory.removeEntry(fileName);
  } catch (error) {
    problems.push(`suppression du fichier : ${error.name}`);
  }
  try {
    await root.removeEntry(PROBE_DIRECTORY, { recursive: true });
  } catch (error) {
    problems.push(`suppression du dossier : ${error.name}`);
  }
  return problems;
}

async function probeSyncAccessHandle() {
  if (!navigator.storage) {
    throw new MissingCapabilityError("navigator.storage n'est pas exposé dans le Worker");
  }
  if (typeof navigator.storage.getDirectory !== "function") {
    throw new MissingCapabilityError("navigator.storage.getDirectory est absent du Worker");
  }

  let root;
  let directory;
  try {
    root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle(PROBE_DIRECTORY, { create: true });
  } catch (error) {
    throw deniedIfRefused(error);
  }

  const fileName = `probe-${Date.now()}.bin`;
  let detail = "";
  let failure = null;
  try {
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    detail = await exerciseSyncAccessHandle(fileHandle);
  } catch (error) {
    failure = deniedIfRefused(error);
  }

  const cleanupProblems = await removeProbeArtefacts(root, directory, fileName);
  if (failure) throw failure;
  if (cleanupProblems.length > 0) {
    throw new Error(`nettoyage incomplet — ${cleanupProblems.join(", ")}`);
  }
  return `${detail}, artefacts supprimés`;
}

function probeAtomicsWait() {
  if (!isConstructorLike(globalThis.SharedArrayBuffer)) {
    throw new MissingCapabilityError("SharedArrayBuffer n'est pas exposé dans le Worker");
  }
  if (typeof Atomics?.wait !== "function") {
    throw new MissingCapabilityError("Atomics.wait n'est pas exposé");
  }

  const view = new Int32Array(new SharedArrayBuffer(4));
  const expired = Atomics.wait(view, 0, 0, 5);
  if (expired !== "timed-out") {
    throw new Error(`attente bloquante inattendue : ${expired}`);
  }

  Atomics.store(view, 0, 1);
  const immediate = Atomics.wait(view, 0, 0);
  if (immediate !== "not-equal") {
    throw new Error(`sortie immédiate inattendue : ${immediate}`);
  }
  return "Atomics.wait bloque puis expire, et détecte une valeur différente";
}

/** Exécute toutes les mesures du Worker et renvoie leurs enregistrements typés. */
export async function runWorkerProbe() {
  return [
    await measureCapability({
      id: "workerWebCryptoAesGcm",
      context: "worker",
      run: () => probeAesGcm("Worker"),
    }),
    await measureCapability({
      id: "opfsSyncAccessHandle",
      context: "worker",
      timeoutMs: 20_000,
      run: probeSyncAccessHandle,
    }),
    await measureCapability({
      id: "workerAtomicsWait",
      context: "worker",
      run: async () => probeAtomicsWait(),
    }),
  ];
}
