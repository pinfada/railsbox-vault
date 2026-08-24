// Worker runtime du banc de bail d'écriture (#8). C'est un contexte réel qui se dispute le bail avec
// les Workers des autres onglets : il tient le VRAI verrou Web Locks et ouvre le VRAI handle OPFS
// exclusif. La coquille lui parle par messages et n'obtient jamais de handle (ADR 0002).
//
// Il n'auto-évalue rien : il rapporte chaque transition de bail avec un horodatage monotone, et
// l'assertion vit dans `tests/browser/write-lease.spec.mjs`. Un Worker terminé brutalement par la
// page ne rapporte plus rien — c'est précisément le cas de crash que la preuve exerce.

import { STORAGE_ERROR_CODES, StorageError } from "/src/vm/storage-errors.mjs";
import { openOpfsSyncAccess, removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { acquireWriteLease } from "/src/vm/write-lease-transport.mjs";
import { LEASE_STATUS } from "/src/vm/write-lease.mjs";

/** Ouvreur fautif : injecte un échec de support typé pour prouver l'affichage « erreur » de l'UI. */
function failingOpener() {
  return () =>
    Promise.reject(
      new StorageError(
        STORAGE_ERROR_CODES.supportFailure,
        "Échec de support injecté pour la preuve d'état « erreur ».",
        { context: "banc-bail" },
      ),
    );
}

let active = null;
let requestOrigin = 0;

/** Statut d'UI d'une transition : l'état du bail, sauf sur erreur de transport où c'est « erreur ». */
function uiStatusOf(lease, errored) {
  return errored ? LEASE_STATUS.error : lease.status;
}

function post(kind, extra) {
  self.postMessage({ kind, ...extra });
}

function snapshot(lease, errored = false) {
  return {
    ...lease.toJSON(),
    uiStatus: uiStatusOf(lease, errored),
    sinceRequestMs: performance.now() - requestOrigin,
  };
}

async function acquire({ volume, deadlineMs, injectHandleError = false }) {
  requestOrigin = performance.now();
  const openHandle = injectHandleError ? failingOpener() : openOpfsSyncAccess;

  active = acquireWriteLease({
    volume,
    openHandle,
    deadlineMs,
    onState: (lease) => post("state", { lease: snapshot(lease) }),
  });

  active.settled.then((report) => {
    const errored = report.outcome === "erreur";
    post("settled", {
      outcome: report.outcome,
      reason: report.reason ?? null,
      errorCode: report.error?.code ?? null,
      lease: snapshot(report.lease, errored),
    });
  });
}

/** Sonde de capacité : ce moteur ouvre-t-il un handle OPFS exclusif dans un Worker ? */
async function capacite() {
  const name = "sonde-bail-capacite";
  try {
    const handle = await openOpfsSyncAccess(name);
    handle.close();
    await removeOpfsVolume(name);
    return { openCode: null };
  } catch (error) {
    return { openCode: typeof error?.code === "string" ? error.code : null };
  }
}

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    if (type === "capacite") {
      post("reply", { id, value: await capacite() });
    } else if (type === "acquire") {
      await acquire(payload ?? {});
      post("reply", { id, value: { started: true } });
    } else if (type === "release") {
      if (!active) throw new Error("Aucun bail actif à relâcher.");
      await active.release();
      post("reply", { id, value: { released: true } });
    } else {
      throw new Error(`Message inattendu : ${type}`);
    }
  } catch (error) {
    post("reply", { id, error: { message: error.message, code: error.code ?? null } });
  }
});

post("ready", {});
