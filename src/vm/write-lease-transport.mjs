// Transport du bail d'écriture (#8, `VAULT-PERSIST-002`).
//
// Couche FINE au-dessus de la machine à états `write-lease.mjs`. Elle traduit trois faits réels du
// navigateur en transitions de bail :
//
//   - Web Locks accorde un verrou nommé à un seul contexte à la fois, en FIFO, et le RELÂCHE à la
//     mort du contexte (onglet fermé, Worker terminé) sans adieu fiable ;
//   - le handle OPFS exclusif (`openOpfsSyncAccess`, #6) n'est ouvrable que par le détenteur du
//     verrou ; sa fermeture EFFECTIVE conditionne l'ouverture du suivant ;
//   - un handle survivant à un contexte mort peut mettre un instant à être réclamé : l'ouverture est
//     donc RÉESSAYÉE sur `VAULT_STORAGE_BUSY` tant que le budget de 5 s dure.
//
// Ce module ne décide de rien : l'exclusivité vient de Web Locks, la durabilité du handle OPFS. Il
// se contente de tenir le verrou pendant qu'il détient le handle, et de fermer le handle AVANT de
// rendre le verrou — de sorte que « le second acquiert après libération effective », et non après un
// simple événement annoncé.

import { STORAGE_ERROR_CODES, isStorageError } from "./storage-errors.mjs";
import { RELAY_DEADLINE_MS, WriteLease } from "./write-lease.mjs";

/** Nom de verrou Web Locks d'un volume. Le préfixe évite toute collision avec un autre usage. */
export function lockNameFor(volume) {
  return `vault-write-lease:${volume}`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ouvre le handle exclusif, en réessayant sur `VAULT_STORAGE_BUSY` tant que le budget n'est pas
 * épuisé. Toute autre erreur (support en panne, capacité absente) est propagée telle quelle : on ne
 * réessaie que ce qui a une chance d'être un handle mort pas encore réclamé.
 */
async function openHandleWithRetry({ openHandle, volume, deadlineAt, now, retryMs, sleep }) {
  for (;;) {
    try {
      return await openHandle(volume);
    } catch (error) {
      const reclaimable = isStorageError(error, STORAGE_ERROR_CODES.busy);
      if (!reclaimable || now() >= deadlineAt) throw error;
      await sleep(Math.min(retryMs, Math.max(0, deadlineAt - now())));
    }
  }
}

/**
 * Acquiert le bail d'écriture d'un volume et le tient jusqu'à `release()`.
 *
 * @param {{
 *   volume: string,
 *   openHandle: (volume: string) => Promise<{ close: () => void }>,
 *   locks?: LockManager,
 *   deadlineMs?: number,
 *   now?: () => number,
 *   retryMs?: number,
 *   onState?: (lease: WriteLease) => void,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 *   `openHandle` est injecté (le vrai `openOpfsSyncAccess` en production, un ouvreur fautif dans les
 *   preuves d'erreur). `now` est l'horloge — `performance.now` par défaut, contrôlable au test.
 * @returns {{ lease: WriteLease, settled: Promise<object>, release: () => Promise<object>,
 *             lockName: string }}
 */
export function acquireWriteLease({
  volume,
  openHandle,
  locks = globalThis.navigator?.locks,
  deadlineMs = RELAY_DEADLINE_MS,
  now = () => performance.now(),
  retryMs = 40,
  onState = () => {},
  sleep = defaultSleep,
}) {
  if (typeof openHandle !== "function") {
    throw new TypeError("acquireWriteLease exige un ouvreur de handle (openHandle).");
  }
  if (!locks || typeof locks.request !== "function") {
    throw new TypeError("Web Locks est indisponible : le bail d'écriture ne peut pas être arbitré.");
  }

  const lockName = lockNameFor(volume);
  let lease = new WriteLease({ volume, now, deadlineMs });
  const emit = (next) => {
    lease = next;
    onState(lease);
    return lease;
  };

  emit(lease.request());
  const deadlineAt = lease.requestedAt + deadlineMs;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);

  let releaseAsked;
  const releaseRequested = new Promise((resolve) => {
    releaseAsked = resolve;
  });
  let held = false;
  let handle = null;

  const inLock = locks.request(lockName, { signal: abort.signal }, async () => {
    // Verrou obtenu. On ouvre le handle exclusif AVANT de se déclarer écrivain : sans handle, il n'y
    // a pas de bail — seulement un verrou. Le réessai couvre le handle d'un contexte mort.
    handle = await openHandleWithRetry({ openHandle, volume, deadlineAt, now, retryMs, sleep });
    held = true;
    emit(lease.grant());
    try {
      await releaseRequested;
    } finally {
      // Fermeture EFFECTIVE puis retour : le prochain `request` de Web Locks ne s'exécute qu'après
      // la résolution de cette promesse, donc APRÈS ce close. Le relais est sûr par construction.
      emit(lease.release());
      handle.close();
      handle = null;
      emit(lease.settle());
    }
  });

  const settled = inLock
    .then(() => ({ outcome: held ? "relais" : "libre", lease }))
    .catch((error) => {
      // Délai dépassé pendant l'attente : refus explicite, jamais un accès concurrent implicite.
      if (!held && (abort.signal.aborted || error?.name === "AbortError")) {
        emit(lease.isOverdue() ? lease.expire() : lease.deny("delai-depasse"));
        return { outcome: "refus", lease, reason: "delai-depasse" };
      }
      // Échec réel du support avant l'octroi : refus typé, remonté pour affichage « erreur ».
      if (!held) emit(lease.deny(codeOf(error)));
      return { outcome: "erreur", lease, error };
    })
    .finally(() => clearTimeout(timer));

  return {
    get lease() {
      return lease;
    },
    lockName,
    settled,
    /** Demande une fermeture propre. Résout `settled` une fois le handle effectivement fermé. */
    release() {
      releaseAsked();
      return settled;
    },
  };
}

/** Code d'erreur typé s'il existe, sinon un libellé générique — jamais `null` silencieux. */
function codeOf(error) {
  return typeof error?.code === "string" ? error.code : "erreur-transport";
}
