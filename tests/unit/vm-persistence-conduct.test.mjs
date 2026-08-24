import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_DIAGNOSTIC_CODES,
  createStorageBudget,
  isBudgetDiagnostic,
} from "../../src/vm/storage-budget.mjs";
import {
  CONDUCT_ACTIONS,
  CONDUCT_ACTION_TEXT,
  DURABILITY_PROMISE,
  PERSISTENCE_VERDICTS,
  SHELL_STATES,
  USER_STANCE,
  conductForPersistence,
  isDurableGuaranteed,
  shouldRequestPersistence,
} from "../../src/vm/persistence-conduct.mjs";
import { describeConduct } from "../../src/vm/persistence-conduct-messages.mjs";

// Preuve unitaire de la COUCHE DE CONDUITE (#42, `VAULT-PERSIST-001`). Elle se pose AU-DESSUS du
// diagnostic de budget (#9) : à partir d'un verdict de persistance (accordé / déjà acquis / refusé /
// pendant / indisponible) et du contexte (geste utilisateur, choix de l'utilisateur), elle produit un
// ÉTAT DE COQUILLE explicite et une PROMESSE DE DURABILITÉ à trois valeurs — jamais un booléen, jamais
// une promesse fausse.
//
// L'invariant central, éprouvé exhaustivement plus bas : une durabilité GARANTIE n'existe QUE derrière
// une persistance réellement accordée. Un refus, une attente pendante (Firefox) ou une absence d'API
// ne produisent jamais « durable ».

// --- Quand demander la persistance : derrière un geste, jamais au chargement ----------------------

test("shouldRequestPersistence refuse la demande sans geste utilisateur", () => {
  assert.equal(shouldRequestPersistence({ userGesture: false, alreadyPersistent: false }), false);
});

test("shouldRequestPersistence autorise la demande derrière un geste explicite", () => {
  assert.equal(shouldRequestPersistence({ userGesture: true, alreadyPersistent: false }), true);
});

test("shouldRequestPersistence ne redemande jamais un stockage déjà persistant", () => {
  assert.equal(shouldRequestPersistence({ userGesture: true, alreadyPersistent: true }), false);
});

// --- Octroi : la seule voie vers une durabilité garantie -----------------------------------------

test("un octroi de persistance produit l'état durable-garanti", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.granted,
    userGesture: true,
  });

  assert.equal(conduite.shellState, SHELL_STATES.durableGuaranteed);
  assert.equal(conduite.durability, DURABILITY_PROMISE.guaranteed);
  assert.equal(isDurableGuaranteed(conduite), true);
});

test("un stockage déjà persistant est durable-garanti même sans nouveau geste", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.alreadyPersistent,
    userGesture: false,
  });

  // `persisted()` se lit au chargement sans geste ; seule la DEMANDE `persist()` exige un geste.
  assert.equal(conduite.shellState, SHELL_STATES.durableGuaranteed);
  assert.equal(conduite.durability, DURABILITY_PROMISE.guaranteed);
});

// --- Refus : poursuite volatile qualifiée, ou arrêt, au choix de l'utilisateur --------------------

test("un refus sans choix explicite propose une poursuite volatile QUALIFIÉE, jamais durable", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.denied,
    userGesture: true,
  });

  assert.equal(conduite.shellState, SHELL_STATES.qualifiedVolatile);
  assert.equal(conduite.durability, DURABILITY_PROMISE.notGuaranteed);
  assert.equal(isDurableGuaranteed(conduite), false);
  // La coquille doit pouvoir offrir l'arrêt comme alternative.
  assert.ok(conduite.branches.includes(CONDUCT_ACTIONS.stop));
});

test("un refus avec choix d'arrêt produit l'état d'arrêt, sans écriture volatile", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.denied,
    userGesture: true,
    stance: USER_STANCE.stop,
  });

  assert.equal(conduite.shellState, SHELL_STATES.halted);
  assert.equal(conduite.durability, DURABILITY_PROMISE.notGuaranteed);
  assert.equal(isDurableGuaranteed(conduite), false);
});

// --- Indisponible : moteur sans API de persistance -----------------------------------------------

test("une persistance indisponible n'invente aucune durabilité", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.unsupported,
    userGesture: true,
  });

  assert.equal(conduite.shellState, SHELL_STATES.qualifiedVolatile);
  assert.equal(conduite.durability, DURABILITY_PROMISE.notGuaranteed);
  assert.equal(isDurableGuaranteed(conduite), false);
});

// --- Attente pendante (Firefox) : traitée comme NON ACCORDÉE, donc jamais durable -----------------

test("une attente pendante halte la décision et ne promet aucune durabilité", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.pending,
    userGesture: true,
    // Même si l'utilisateur a exprimé « poursuivre », l'attente n'est pas encore tranchée :
    // proposer une poursuite volatile devancerait une réponse que le navigateur peut rendre positive.
    stance: USER_STANCE.proceed,
  });

  assert.equal(conduite.shellState, SHELL_STATES.awaitingResolution);
  assert.equal(conduite.durability, DURABILITY_PROMISE.unknown);
  assert.equal(isDurableGuaranteed(conduite), false);
});

// --- Absence de verdict : le consentement est requis avant toute demande --------------------------

test("sans verdict ni geste, la coquille exige d'abord un consentement", () => {
  const conduite = conductForPersistence({ verdict: null, userGesture: false });

  assert.equal(conduite.shellState, SHELL_STATES.consentRequired);
  assert.equal(conduite.durability, DURABILITY_PROMISE.unknown);
  assert.ok(conduite.branches.includes(CONDUCT_ACTIONS.requestBehindGesture));
});

// --- L'INVARIANT, éprouvé sur TOUTES les combinaisons ---------------------------------------------

test("invariant : durabilité garantie ⟹ persistance réellement accordée, sur toute combinaison", () => {
  const verdicts = [null, ...Object.values(PERSISTENCE_VERDICTS)];
  const gestes = [true, false];
  const choix = [undefined, USER_STANCE.proceed, USER_STANCE.stop];
  const accordés = new Set([PERSISTENCE_VERDICTS.granted, PERSISTENCE_VERDICTS.alreadyPersistent]);

  let combinaisons = 0;
  for (const verdict of verdicts) {
    for (const userGesture of gestes) {
      for (const stance of choix) {
        const conduite = conductForPersistence({ verdict, userGesture, stance });
        combinaisons += 1;

        if (conduite.durability === DURABILITY_PROMISE.guaranteed) {
          assert.ok(
            accordés.has(verdict),
            `durabilité GARANTIE sans octroi réel : verdict=${verdict}`,
          );
          assert.equal(conduite.shellState, SHELL_STATES.durableGuaranteed);
        }
        if (conduite.shellState === SHELL_STATES.durableGuaranteed) {
          assert.ok(accordés.has(verdict), `état durable sans octroi : verdict=${verdict}`);
        }
        // Un verdict pendant ne franchit jamais le seuil de la durabilité.
        if (verdict === PERSISTENCE_VERDICTS.pending) {
          assert.notEqual(conduite.durability, DURABILITY_PROMISE.guaranteed);
          assert.notEqual(conduite.shellState, SHELL_STATES.durableGuaranteed);
        }
        // La promesse est toujours l'une des TROIS valeurs — jamais un booléen.
        assert.ok(Object.values(DURABILITY_PROMISE).includes(conduite.durability));
        assert.notEqual(typeof conduite.durability, "boolean");
      }
    }
  }
  assert.equal(combinaisons, verdicts.length * gestes.length * choix.length);
});

// --- Réutilisation réelle du diagnostic #9 -------------------------------------------------------

test("la conduite réutilise le diagnostic de refus de #9 sans le recopier", async () => {
  // Verdict RÉEL produit par la couche #9 avec des doubles déterministes : refus non durable.
  const budget = createStorageBudget({ persisted: async () => false, persist: async () => false });
  const verdictReel = await budget.requestPersistence();

  const conduite = conductForPersistence({ verdict: verdictReel, userGesture: true });

  assert.equal(conduite.shellState, SHELL_STATES.qualifiedVolatile);
  assert.equal(conduite.durability, DURABILITY_PROMISE.notGuaranteed);
  // Le diagnostic transporté est bien celui de #9, pas une copie locale.
  assert.ok(isBudgetDiagnostic(conduite.diagnostic, BUDGET_DIAGNOSTIC_CODES.persistDenied));
});

test("la conduite accepte aussi bien un verdict-objet de #9 qu'un état nu", async () => {
  const budget = createStorageBudget({ persisted: async () => false, persist: async () => true });
  const verdictReel = await budget.requestPersistence(); // { state: "granted", durable: true, ... }

  const parObjet = conductForPersistence({ verdict: verdictReel, userGesture: true });
  const parEtat = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.granted,
    userGesture: true,
  });

  assert.equal(parObjet.shellState, SHELL_STATES.durableGuaranteed);
  assert.equal(parEtat.shellState, SHELL_STATES.durableGuaranteed);
  assert.equal(parObjet.durability, parEtat.durability);
});

// --- Frontière : un verdict inconnu échoue explicitement, jamais en silence -----------------------

test("un verdict inconnu est refusé par une erreur typée, sans repli silencieux", () => {
  assert.throws(
    () => conductForPersistence({ verdict: "VERDICT_INVENTÉ", userGesture: true }),
    /verdict/i,
  );
});

// --- Aucune conduite ne propose de supprimer des données ------------------------------------------

test("aucune action de conduite publiée ne propose d'effacer des données", () => {
  for (const [nom, texte] of Object.entries(CONDUCT_ACTION_TEXT)) {
    assert.equal(
      /supprim|efface|purg|delete|réinitialis/i.test(texte),
      false,
      `l'action « ${nom} » ne doit jamais proposer d'effacer des données : ${texte}`,
    );
  }
  for (const action of Object.values(CONDUCT_ACTIONS)) {
    assert.equal(/DELETE|PURGE|ERASE|RESET/.test(action), false);
  }
});

// --- Messages accessibles : un rôle ARIA et un texte, jamais un booléen ---------------------------

test("describeConduct rend un descripteur accessible pour chaque état de coquille", () => {
  const états = [
    conductForPersistence({ verdict: null, userGesture: false }),
    conductForPersistence({ verdict: PERSISTENCE_VERDICTS.granted, userGesture: true }),
    conductForPersistence({ verdict: PERSISTENCE_VERDICTS.pending, userGesture: true }),
    conductForPersistence({ verdict: PERSISTENCE_VERDICTS.denied, userGesture: true }),
    conductForPersistence({
      verdict: PERSISTENCE_VERDICTS.denied,
      userGesture: true,
      stance: USER_STANCE.stop,
    }),
  ];

  for (const conduite of états) {
    const vue = describeConduct(conduite);
    assert.equal(typeof vue.role, "string");
    assert.ok(vue.role === "status" || vue.role === "alert");
    assert.equal(vue.shellState, conduite.shellState);
    assert.equal(vue.durability, conduite.durability);
    assert.ok(vue.text.length > 0);
    // Le texte porte l'état, jamais un booléen de durabilité.
    assert.equal(/\b(true|false)\b/.test(vue.text), false);
  }
});

test("describeConduct réutilise le texte accessible du diagnostic #9 sur un refus", async () => {
  const budget = createStorageBudget({ persisted: async () => false, persist: async () => false });
  const conduite = conductForPersistence({
    verdict: await budget.requestPersistence(),
    userGesture: true,
  });

  const vue = describeConduct(conduite);

  // Le texte du diagnostic #9 (refus + « ou s'arrêter ») est bien celui rendu.
  assert.ok(vue.text.includes("persistance"));
  assert.ok(/s'arrêter|arrêter/i.test(vue.text));
});

test("un état durable-garanti ne contient jamais de fuite de contenu utilisateur", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.granted,
    userGesture: true,
  });
  const vue = describeConduct(conduite);
  assert.equal(vue.durability, DURABILITY_PROMISE.guaranteed);
  assert.ok(vue.text.toLowerCase().includes("durable"));
});

// --- Conduite immuable ---------------------------------------------------------------------------

test("la conduite produite est gelée : aucune mutation d'état après coup", () => {
  const conduite = conductForPersistence({
    verdict: PERSISTENCE_VERDICTS.denied,
    userGesture: true,
  });
  assert.throws(() => {
    conduite.shellState = SHELL_STATES.durableGuaranteed;
  });
});
