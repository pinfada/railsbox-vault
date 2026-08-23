import assert from "node:assert/strict";
import test from "node:test";

import { FAULT_KINDS, createFaultPlan } from "../../src/vm/fault-plan.mjs";

test("un plan vide ne déclenche jamais rien", () => {
  const plan = createFaultPlan();
  assert.equal(plan.consume("read"), null);
  assert.equal(plan.consume("write"), null);
  assert.deepEqual(plan.fired(), []);
});

test("la faute se déclenche au rang exact de son opération, une seule fois", () => {
  const plan = createFaultPlan([{ kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 2 }]);

  assert.equal(plan.consume("read"), null);
  assert.equal(plan.consume("read").kind, FAULT_KINDS.shortRead);
  assert.equal(plan.consume("read"), null);
  assert.equal(plan.fired().length, 1);
});

test("les compteurs des opérations sont indépendants", () => {
  const plan = createFaultPlan([
    { kind: FAULT_KINDS.partialWrite, operation: "write", occurrence: 1 },
  ]);

  plan.consume("read");
  plan.consume("read");
  assert.equal(plan.consume("write").kind, FAULT_KINDS.partialWrite);
});

test("un plan est rejoué à l'identique par une nouvelle instance", () => {
  const specs = [
    { kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 3 },
    { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1 },
  ];
  const trace = () => {
    const plan = createFaultPlan(specs);
    const suite = [];
    for (let index = 0; index < 4; index += 1) {
      suite.push(plan.consume("read")?.kind ?? null, plan.consume("flush")?.kind ?? null);
    }
    return suite;
  };
  assert.deepEqual(trace(), trace());
});

test("une faute incohérente avec son opération est refusée à la construction", () => {
  assert.throws(
    () => createFaultPlan([{ kind: FAULT_KINDS.flushFailure, operation: "read", occurrence: 1 }]),
    /ne s'applique qu'à l'opération flush/,
  );
  assert.throws(
    () => createFaultPlan([{ kind: "inventee", operation: "read", occurrence: 1 }]),
    /Type de faute inconnu/,
  );
  assert.throws(
    () => createFaultPlan([{ kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 0 }]),
    /entier supérieur ou égal à 1/,
  );
});

test("deux fautes sur le même rang seraient ambiguës et sont refusées", () => {
  assert.throws(
    () =>
      createFaultPlan([
        { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1 },
        { kind: FAULT_KINDS.lostHandle, operation: "read", occurrence: 1 },
      ]),
    /le plan serait ambigu/,
  );
});

test("une faute programmée mais jamais atteinte est rapportée comme telle", () => {
  const plan = createFaultPlan([{ kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 5 }]);
  plan.consume("read");
  assert.equal(plan.unfired().length, 1);
});
