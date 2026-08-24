// Arbitre modèle du bail d'écriture (#8, `VAULT-PERSIST-002`).
//
// C'est le MODÈLE PUR du transport, sous Node : une file d'attente à détenteur unique qui reproduit
// les deux propriétés sur lesquelles le produit s'appuie réellement —
//
//   1. Web Locks accorde un verrou nommé à UN seul demandeur à la fois, en FIFO ;
//   2. un verrou détenu est libéré à la MORT du contexte, sans adieu fiable.
//
// L'arbitre ne remplace pas la preuve navigateur : il rend l'invariant « au plus un écrivain » et la
// règle de récupération après crash vérifiables DÉTERMINISTIQUEMENT, avec une horloge injectée, là
// où le vrai Web Locks ne laisse contrôler ni le temps ni l'instant d'une mort de contexte. Le banc
// `tests/browser/write-lease.spec.mjs` prouve ensuite que le vrai transport se comporte comme ce
// modèle le suppose.

import { RELAY_DEADLINE_MS, WriteLease, assertAtMostOneWriter } from "./write-lease.mjs";

/**
 * @param {{ now?: () => number, deadlineMs?: number }} [options]
 *   `now` est l'horloge injectée (millisecondes). `deadlineMs` borne le relais-ou-refus.
 */
export function createLeaseArbiter({ now = () => 0, deadlineMs = RELAY_DEADLINE_MS } = {}) {
  /** @type {Map<string, { holder: string | null, queue: string[], leases: Map<string, WriteLease> }>} */
  const volumes = new Map();

  const volumeOf = (name) => {
    let entry = volumes.get(name);
    if (!entry) {
      entry = { holder: null, queue: [], leases: new Map() };
      volumes.set(name, entry);
    }
    return entry;
  };

  const leaseOf = (volume, id) => {
    const entry = volumeOf(volume);
    let bail = entry.leases.get(id);
    if (!bail) {
      bail = new WriteLease({ volume, now, deadlineMs });
      entry.leases.set(id, bail);
    }
    return bail;
  };

  const setLease = (entry, id, bail) => {
    entry.leases.set(id, bail);
    return bail;
  };

  /**
   * Promeut le prochain demandeur si le volume est libre. Un seul détenteur peut sortir de la file :
   * c'est là que l'exclusivité de Web Locks est modélisée. Le relais n'a lieu qu'une fois le volume
   * effectivement libéré (détenteur `null`), jamais sur une simple annonce.
   */
  const promote = (entry) => {
    if (entry.holder !== null) return;
    const next = entry.queue.shift();
    if (next === undefined) return;
    setLease(entry, next, entry.leases.get(next).grant());
    entry.holder = next;
  };

  /** Vérifie l'invariant central sur TOUS les volumes. Appelé après chaque mutation. */
  const checkInvariant = () => {
    for (const entry of volumes.values()) {
      assertAtMostOneWriter(entry.leases.values());
    }
  };

  return Object.freeze({
    /** Demande le bail. Accorde tout de suite si libre, sinon met en file d'attente. */
    request(volume, id) {
      const entry = volumeOf(volume);
      const bail = setLease(entry, id, leaseOf(volume, id).request());
      if (entry.holder === null && entry.queue.length === 0) {
        setLease(entry, id, bail.grant());
        entry.holder = id;
      } else {
        entry.queue.push(id);
      }
      checkInvariant();
      return entry.leases.get(id);
    },

    /** Fermeture propre du détenteur : relais → libre, puis promotion du suivant. */
    release(volume, id) {
      const entry = volumeOf(volume);
      if (entry.holder !== id) {
        throw new Error(`« ${id} » ne détient pas « ${volume} » : rien à relâcher.`);
      }
      setLease(entry, id, entry.leases.get(id).release().settle());
      entry.holder = null;
      promote(entry);
      checkInvariant();
    },

    /**
     * Mort du contexte : le verrou tombe SANS fermeture propre. Un détenteur qui meurt perd son
     * bail (état `perdu`) ; un waiter qui meurt quitte simplement la file. Le suivant est promu sans
     * qu'aucun événement d'adieu n'ait été supposé — c'est la règle de récupération de #8.
     */
    kill(volume, id) {
      const entry = volumeOf(volume);
      if (entry.holder === id) {
        setLease(entry, id, entry.leases.get(id).lose("contexte-mort"));
        entry.holder = null;
        promote(entry);
      } else {
        const index = entry.queue.indexOf(id);
        if (index !== -1) entry.queue.splice(index, 1);
        const bail = entry.leases.get(id);
        if (bail?.state === "attente") setLease(entry, id, bail.abandon());
      }
      checkInvariant();
    },

    /** Passe les demandeurs dont l'échéance est atteinte à l'état refus (conflit). */
    poll() {
      for (const entry of volumes.values()) {
        const survivants = [];
        for (const id of entry.queue) {
          const bail = entry.leases.get(id);
          if (bail.isOverdue()) {
            setLease(entry, id, bail.expire());
          } else {
            survivants.push(id);
          }
        }
        entry.queue = survivants;
      }
      checkInvariant();
    },

    leaseOf,
    holderOf: (volume) => volumeOf(volume).holder,
    checkInvariant,

    /** Délai mesuré entre la demande et l'octroi d'un bail détenu : la métrique de relais. */
    relayDelay(volume, id) {
      const bail = volumeOf(volume).leases.get(id);
      if (!bail || bail.grantedAt === null || bail.requestedAt === null) return null;
      return bail.grantedAt - bail.requestedAt;
    },
  });
}
