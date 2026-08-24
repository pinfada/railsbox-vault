import assert from "node:assert/strict";
import test from "node:test";

import {
  LEASE_STATES,
  LEASE_STATUS,
  LEASE_TRANSITIONS,
  LeaseTransitionError,
  RELAY_DEADLINE_MS,
  WriteLease,
  assertAtMostOneWriter,
} from "../../src/vm/write-lease.mjs";
import { createLeaseArbiter } from "../../src/vm/write-lease-arbiter.mjs";

// Preuve unitaire de la MACHINE À ÉTATS du bail d'écriture (#8, `VAULT-PERSIST-002`). Elle éprouve
// la logique pure — transitions, invariant « au plus un écrivain », règle de récupération après
// perte — sur une horloge et des événements INJECTÉS, sans Web Locks, sans OPFS, sans navigateur.
// Le niveau navigateur (`tests/browser/write-lease.spec.mjs`) prouve ensuite que le vrai transport
// (Web Locks + handle OPFS exclusif) respecte réellement les sémantiques que ce modèle suppose.
//
// La machine est distincte du transport à dessein : une machine testable sous Node capture
// l'invariant, tandis que le transport n'est qu'une couche fine qui l'alimente en événements.

/** Horloge contrôlée : le test avance le temps, la machine ne le lit jamais elle-même. */
function horloge(depart = 0) {
  let t = depart;
  return { now: () => t, avancer: (ms) => (t += ms) };
}

test("un bail neuf est libre, en lecture seule et sans écrivain", () => {
  const bail = new WriteLease({ volume: "v", now: () => 0 });
  assert.equal(bail.state, LEASE_STATES.free);
  assert.equal(bail.status, LEASE_STATUS.readOnly);
  assert.equal(bail.isWriter, false);
});

test("le cycle propre traverse attente → détenu → relais → libre", () => {
  const h = horloge();
  const libre = new WriteLease({ volume: "v", now: h.now, deadlineMs: 5000 });

  const attente = libre.request();
  assert.equal(attente.state, LEASE_STATES.waiting);
  assert.equal(attente.status, LEASE_STATUS.waiting);
  assert.equal(attente.remainingMs(), 5000);

  const detenu = attente.grant();
  assert.equal(detenu.state, LEASE_STATES.held);
  assert.equal(detenu.status, LEASE_STATUS.writing);
  assert.equal(detenu.isWriter, true);

  const relais = detenu.release();
  assert.equal(relais.state, LEASE_STATES.relaying);
  assert.equal(relais.isWriter, false);

  const rendu = relais.settle();
  assert.equal(rendu.state, LEASE_STATES.free);
});

test("les transitions sont immuables : la source n'est jamais modifiée", () => {
  const libre = new WriteLease({ volume: "v", now: () => 0 });
  const attente = libre.request();
  assert.equal(libre.state, LEASE_STATES.free, "la source reste libre");
  assert.notEqual(attente, libre);
});

test("un refus explicite mène à l'état conflit, avec sa raison", () => {
  const bail = new WriteLease({ volume: "v", now: () => 0 }).request().deny("autre-detenteur");
  assert.equal(bail.state, LEASE_STATES.denied);
  assert.equal(bail.status, LEASE_STATUS.conflict);
  assert.equal(bail.reason, "autre-detenteur");
});

test("l'expiration n'est possible qu'une fois le délai atteint", () => {
  const h = horloge();
  const attente = new WriteLease({ volume: "v", now: h.now, deadlineMs: 5000 }).request();

  assert.throws(() => attente.expire(), LeaseTransitionError, "expirer avant le délai est refusé");

  h.avancer(5000);
  const refus = attente.expire();
  assert.equal(refus.state, LEASE_STATES.denied);
  assert.equal(refus.status, LEASE_STATUS.conflict);
  assert.equal(attente.remainingMs(), 0);
});

test("la perte du support mène à l'état erreur", () => {
  const bail = new WriteLease({ volume: "v", now: () => 0 }).request().grant().lose("handle-perdu");
  assert.equal(bail.state, LEASE_STATES.lost);
  assert.equal(bail.status, LEASE_STATUS.error);
  assert.equal(bail.reason, "handle-perdu");
});

test("une transition interdite lève une erreur typée sans changer d'état", () => {
  const libre = new WriteLease({ volume: "v", now: () => 0 });
  assert.throws(() => libre.grant(), LeaseTransitionError, "on ne détient pas sans attendre");

  const attente = libre.request();
  assert.throws(() => attente.release(), LeaseTransitionError, "on ne relaie pas ce qu'on n'a pas");

  const erreur = (() => {
    try {
      libre.grant();
    } catch (e) {
      return e;
    }
  })();
  assert.equal(erreur.code, "VAULT_LEASE_TRANSITION");
  assert.equal(erreur.from, LEASE_STATES.free);
  assert.equal(erreur.event, "grant");
});

test("la table de transitions et les méthodes concordent", () => {
  // Chaque état de la table est une valeur connue, chaque cible aussi : la table ne peut pas
  // désigner un état fantôme que les méthodes ne sauraient pas produire.
  const etats = new Set(Object.values(LEASE_STATES));
  for (const [from, evenements] of Object.entries(LEASE_TRANSITIONS)) {
    assert.ok(etats.has(from), `état source connu : ${from}`);
    for (const cible of Object.values(evenements)) {
      assert.ok(etats.has(cible), `état cible connu : ${cible}`);
    }
  }
});

test("assertAtMostOneWriter refuse deux écrivains simultanés", () => {
  const a = new WriteLease({ volume: "v", now: () => 0 }).request().grant();
  const b = new WriteLease({ volume: "v", now: () => 0 }).request().grant();
  assert.throws(() => assertAtMostOneWriter([a, b]), LeaseTransitionError);
  assert.doesNotThrow(() => assertAtMostOneWriter([a, b.release()]));
});

// --- Arbitre : le modèle pur du transport (Web Locks FIFO + libération à la mort du contexte) ---

test("deux demandeurs sur le même volume : un seul détient, l'autre attend", () => {
  const h = horloge();
  const arbitre = createLeaseArbiter({ now: h.now, deadlineMs: 5000 });

  const a = arbitre.request("vol", "A");
  const b = arbitre.request("vol", "B");

  assert.equal(a.state, LEASE_STATES.held);
  assert.equal(b.state, LEASE_STATES.waiting);
  assert.equal(arbitre.holderOf("vol"), "A");
  assert.doesNotThrow(() => arbitre.checkInvariant());
});

test("fermeture propre : le second acquiert, avec un délai de relais mesuré", () => {
  const h = horloge();
  const arbitre = createLeaseArbiter({ now: h.now, deadlineMs: 5000 });

  arbitre.request("vol", "A");
  arbitre.request("vol", "B");

  h.avancer(1200);
  arbitre.release("vol", "A");

  assert.equal(arbitre.leaseOf("vol", "B").state, LEASE_STATES.held);
  assert.equal(arbitre.holderOf("vol"), "B");
  assert.equal(arbitre.relayDelay("vol", "B"), 1200, "B a attendu 1,2 s avant le relais");
  assert.ok(arbitre.relayDelay("vol", "B") < 5000, "le relais tient sous le budget");
});

test("crash du détenteur : récupération sans événement de fermeture fiable", () => {
  const h = horloge();
  const arbitre = createLeaseArbiter({ now: h.now, deadlineMs: 5000 });

  arbitre.request("vol", "A");
  arbitre.request("vol", "B");

  h.avancer(800);
  // Le détenteur meurt SANS relâcher proprement : c'est la mort du contexte, pas un adieu annoncé.
  arbitre.kill("vol", "A");

  assert.equal(arbitre.leaseOf("vol", "A").state, LEASE_STATES.lost);
  assert.equal(arbitre.leaseOf("vol", "B").state, LEASE_STATES.held);
  assert.equal(arbitre.holderOf("vol"), "B");
  assert.equal(arbitre.relayDelay("vol", "B"), 800);
  assert.doesNotThrow(() => arbitre.checkInvariant());
});

test("le demandeur en attente est refusé au bout du délai, jamais servi en double", () => {
  const h = horloge();
  const arbitre = createLeaseArbiter({ now: h.now, deadlineMs: 5000 });

  arbitre.request("vol", "A");
  arbitre.request("vol", "B");

  h.avancer(5000);
  arbitre.poll();

  assert.equal(arbitre.leaseOf("vol", "B").state, LEASE_STATES.denied);
  assert.equal(arbitre.leaseOf("vol", "B").status, LEASE_STATUS.conflict);
  assert.equal(arbitre.holderOf("vol"), "A", "A détient toujours : B n'a jamais écrit");
});

test("volumes différents : aucune contention artificielle", () => {
  const h = horloge();
  const arbitre = createLeaseArbiter({ now: h.now, deadlineMs: 5000 });

  const a = arbitre.request("vol-1", "A");
  const b = arbitre.request("vol-2", "B");

  assert.equal(a.state, LEASE_STATES.held);
  assert.equal(b.state, LEASE_STATES.held);
  assert.equal(arbitre.holderOf("vol-1"), "A");
  assert.equal(arbitre.holderOf("vol-2"), "B");
  assert.doesNotThrow(() => arbitre.checkInvariant());
});

test("un onglet suspendu ne libère rien : le waiter reste en attente, jamais écrivain", () => {
  const h = horloge();
  const arbitre = createLeaseArbiter({ now: h.now, deadlineMs: 60000 });

  arbitre.request("vol", "A");
  arbitre.request("vol", "B");

  // « Suspension » : le temps passe SANS release ni kill. Un onglet gelé n'est pas un onglet mort.
  h.avancer(30000);
  arbitre.poll();
  assert.equal(arbitre.leaseOf("vol", "B").state, LEASE_STATES.waiting, "B patiente encore");
  assert.equal(arbitre.holderOf("vol"), "A");

  // Réveil puis fermeture propre : le relais se fait alors, et alors seulement.
  arbitre.release("vol", "A");
  assert.equal(arbitre.leaseOf("vol", "B").state, LEASE_STATES.held);
  assert.equal(RELAY_DEADLINE_MS, 5000, "le budget par défaut du produit est de 5 s");
});
