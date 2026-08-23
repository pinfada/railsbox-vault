// État que la coquille de confiance dépose sur SON origine avant d'ouvrir le document applicatif.
// Chaque dépôt imite un actif réel du produit : le volume OPFS, les métadonnées IndexedDB, le
// verrou d'écrivain unique, le canal de contrôle inter-onglets et un secret laissé à portée de
// realm. Les valeurs sont synthétiques ; leur seul rôle est d'être lisibles ou non depuis
// l'application, ce que mesurent les sondes de `app-probe.mjs`.

export const SHELL_SECRET = "cle-de-volume-synthetique-spike-35";
export const OPFS_VOLUME_MARKER = "vault-volume.marker";
export const OPFS_HOSTILE_MARKER = "hostile.marker";
export const IDB_NAME = "vault-shell";
export const IDB_STORE = "secrets";
export const IDB_SHELL_KEY = "cle-de-volume";
export const IDB_HOSTILE_KEY = "empreinte-hostile";
export const STORAGE_KEY = "vault.shell.secret";
export const VOLUME_LOCK_NAME = "vault.volume.exclusive";
export const CONTROL_CHANNEL_NAME = "vault.control";

/** Décrit une erreur sans jamais la convertir en succès ni en valeur vide. */
export function describeFailure(error) {
  return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
}

export function openShellDatabase() {
  return new Promise((resolved, failed) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolved(request.result);
    request.onerror = () => failed(request.error ?? new Error("ouverture IndexedDB refusée"));
  });
}

export function transact(database, mode, run) {
  return new Promise((resolved, failed) => {
    const transaction = database.transaction(IDB_STORE, mode);
    const request = run(transaction.objectStore(IDB_STORE));
    request.onsuccess = () => resolved(request.result);
    request.onerror = () => failed(request.error ?? new Error("transaction IndexedDB refusée"));
  });
}

async function writeOpfsMarker(name, contents) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

export async function readOpfsMarker(name) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  return (await handle.getFile()).text();
}

/**
 * Prend le verrou d'écrivain unique et ne le relâche jamais pendant la session : c'est
 * l'invariant « jamais deux écrivains » de `docs/quality-attributes.md`.
 * @returns {Promise<string>} résolue à l'acquisition
 */
export function holdVolumeLock() {
  return new Promise((acquired, failed) => {
    navigator.locks
      .request(VOLUME_LOCK_NAME, { mode: "exclusive" }, () => {
        acquired("tenu");
        return new Promise(() => {});
      })
      .catch((error) => failed(error));
  });
}

/**
 * Dépose l'état de la coquille et rend un relevé par actif. Un dépôt qui échoue est nommé, jamais
 * ignoré : un test vert sur un appât absent ne prouverait rien.
 * @returns {Promise<Record<string, string>>}
 */
export async function plantShellState() {
  const report = {};

  try {
    await writeOpfsMarker(OPFS_VOLUME_MARKER, SHELL_SECRET);
    report.opfs = "depose";
  } catch (error) {
    report.opfs = describeFailure(error);
  }

  try {
    const database = await openShellDatabase();
    await transact(database, "readwrite", (store) => store.put(SHELL_SECRET, IDB_SHELL_KEY));
    database.close();
    report.indexedDb = "depose";
  } catch (error) {
    report.indexedDb = describeFailure(error);
  }

  try {
    localStorage.setItem(STORAGE_KEY, SHELL_SECRET);
    sessionStorage.setItem(STORAGE_KEY, SHELL_SECRET);
    report.storage = "depose";
  } catch (error) {
    report.storage = describeFailure(error);
  }

  try {
    report.lock = await holdVolumeLock();
  } catch (error) {
    report.lock = describeFailure(error);
  }

  return report;
}
