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
 * Refuse d'emblée ce qui ne peut pas être arbitré du tout.
 *
 * Cette couture existe pour que le corps d'`acquireWriteLease` n'ouvre que sur des gestes qui
 * engagent réellement le bail : un ouvreur absent ou un Web Locks indisponible ne sont pas des états
 * du bail — aucune transition ne les décrit —, ce sont des défauts de câblage, et ils se rejettent
 * avant que la moindre horloge ne démarre.
 */
function refuserSansPrerequis({ openHandle, locks }) {
  if (typeof openHandle !== "function") {
    throw new TypeError("acquireWriteLease exige un ouvreur de handle (openHandle).");
  }
  if (!locks || typeof locks.request !== "function") {
    throw new TypeError(
      "Web Locks est indisponible : le bail d'écriture ne peut pas être arbitré.",
    );
  }
}

/**
 * Journal MUTABLE du bail : le dernier état connu, et l'unique geste qui le fait avancer.
 *
 * Il vit à part parce que TROIS couches le partagent — le corps tenu sous le verrou, la conclusion
 * de `settled`, et le contrat rendu à l'appelant — et qu'une variable de clôture ne se passe pas en
 * paramètre. `detenu` dit si l'octroi a EU LIEU : c'est lui, et lui seul, qui sépare ensuite un
 * refus d'un échec de support.
 */
function creerJournalDuBail({ volume, now, deadlineMs, onState }) {
  let bail = new WriteLease({ volume, now, deadlineMs });
  return {
    get bail() {
      return bail;
    },
    detenu: false,
    emettre(suivant) {
      bail = suivant;
      onState(bail);
      return bail;
    },
  };
}

/** Promesse résolue par le premier `release()` : l'unique signal d'une fermeture propre. */
function creerDemandeDeFermeture() {
  let demander;
  const attendue = new Promise((resolve) => {
    demander = resolve;
  });
  return { demander, attendue };
}

/**
 * Corps tenu SOUS le verrou : ouvrir le handle, se déclarer écrivain, puis attendre la demande de
 * fermeture.
 *
 * Extrait pour que l'ordre qui FONDE le relais — fermer le handle avant de rendre le verrou — se
 * lise d'un bloc, sans le câblage qui l'entoure. L'enchaînement des gestes et le `finally` sont ceux
 * d'origine, à la ligne près : c'est la seule chose que cette couture n'a pas le droit de changer.
 *
 * Le handle devient LOCAL au passage, et le `handle = null` qui suivait la fermeture disparaît avec
 * la variable partagée qu'il servait à vider : la référence ne survit plus à cet appel, il n'y a
 * donc plus rien à relâcher à la main.
 */
async function tenirLeHandleSousVerrou({ journal, ouverture, fermetureDemandee }) {
  // Verrou obtenu. On ouvre le handle exclusif AVANT de se déclarer écrivain : sans handle, il n'y
  // a pas de bail — seulement un verrou. Le réessai couvre le handle d'un contexte mort.
  const handle = await openHandleWithRetry(ouverture);
  journal.detenu = true;
  journal.emettre(journal.bail.grant());
  try {
    await fermetureDemandee;
  } finally {
    // Fermeture EFFECTIVE puis retour : le prochain `request` de Web Locks ne s'exécute qu'après
    // la résolution de cette promesse, donc APRÈS ce close. Le relais est sûr par construction.
    journal.emettre(journal.bail.release());
    handle.close();
    journal.emettre(journal.bail.settle());
  }
}

/**
 * Conclut le bail à partir de l'issue du verrou : relais, refus ou erreur.
 *
 * Extraite parce que c'est la SEULE couche qui traduit un échec de plateforme en état de bail, et
 * qu'elle doit se lire d'un bloc : sans elle sous les yeux, rien ne dit qu'un délai dépassé produit
 * un refus explicite plutôt qu'un accès concurrent implicite.
 */
function conclureLeBail({ inLock, journal, abort, timer }) {
  return inLock
    .then(() => ({ outcome: journal.detenu ? "relais" : "libre", lease: journal.bail }))
    .catch((error) => {
      // Délai dépassé pendant l'attente : refus explicite, jamais un accès concurrent implicite.
      if (!journal.detenu && (abort.signal.aborted || error?.name === "AbortError")) {
        const bail = journal.bail;
        journal.emettre(bail.isOverdue() ? bail.expire() : bail.deny("delai-depasse"));
        return { outcome: "refus", lease: journal.bail, reason: "delai-depasse" };
      }
      // Échec réel du support avant l'octroi : refus typé, remonté pour affichage « erreur ».
      if (!journal.detenu) journal.emettre(journal.bail.deny(codeOf(error)));
      return { outcome: "erreur", lease: journal.bail, error };
    })
    .finally(() => clearTimeout(timer));
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
  refuserSansPrerequis({ openHandle, locks });

  const lockName = lockNameFor(volume);
  const journal = creerJournalDuBail({ volume, now, deadlineMs, onState });

  journal.emettre(journal.bail.request());
  const deadlineAt = journal.bail.requestedAt + deadlineMs;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);

  const fermeture = creerDemandeDeFermeture();

  const inLock = locks.request(lockName, { signal: abort.signal }, () =>
    tenirLeHandleSousVerrou({
      journal,
      ouverture: { openHandle, volume, deadlineAt, now, retryMs, sleep },
      fermetureDemandee: fermeture.attendue,
    }),
  );

  const settled = conclureLeBail({ inLock, journal, abort, timer });

  return {
    get lease() {
      return journal.bail;
    },
    lockName,
    settled,
    /** Demande une fermeture propre. Résout `settled` une fois le handle effectivement fermé. */
    release() {
      fermeture.demander();
      return settled;
    },
  };
}

/** Code d'erreur typé s'il existe, sinon un libellé générique — jamais `null` silencieux. */
function codeOf(error) {
  return typeof error?.code === "string" ? error.code : "erreur-transport";
}
