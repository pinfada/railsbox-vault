import assert from "node:assert/strict";
import test from "node:test";

import { HARNAIS_RESILIENCE_ENV, HARNAIS_RESILIENCE_VALEUR } from "../../src/vm/crash-harness.mjs";
import { CRASH_KINDS, armerInjecteur, planifierCoupures } from "../../src/vm/crash-plan.mjs";
import { FAULT_KINDS } from "../../src/vm/fault-plan.mjs";

// L'armement est gardé (`vm-crash-harnais.test.mjs` fige le refus). Ce fichier mesure la SÉQUENCE,
// il doit donc pouvoir armer : la variable du harnais est posée ici, et nulle part ailleurs.
process.env[HARNAIS_RESILIENCE_ENV] = HARNAIS_RESILIENCE_VALEUR;

const PROFIL = Object.freeze({ points: 12, ecritures: 24, barrieres: 3, tailleBloc: 512 });

test("la même graine rend exactement la même séquence de points de coupure", () => {
  const premiere = planifierCoupures(4242, PROFIL);
  const seconde = planifierCoupures(4242, PROFIL);
  assert.deepEqual(premiere, seconde);
  assert.equal(premiere.length, PROFIL.points);
});

test("deux graines distinctes ne rendent pas la même séquence", () => {
  const a = planifierCoupures(1, PROFIL);
  const b = planifierCoupures(2, PROFIL);
  assert.notDeepEqual(a, b);
});

test("chaque point publie sa graine, son rang et de quoi le rejouer seul", () => {
  const points = planifierCoupures(7, PROFIL);
  points.forEach((point, rang) => {
    assert.equal(point.graine, 7);
    assert.equal(point.index, rang);
    assert.ok(Object.values(CRASH_KINDS).includes(point.kind), `genre inconnu : ${point.kind}`);
    assert.ok(["read", "write", "flush"].includes(point.operation));
    assert.ok(Number.isInteger(point.occurrence) && point.occurrence >= 1);
    assert.ok(Object.isFrozen(point));
  });
});

test("les trois genres de coupure du contrat sont tous atteignables", () => {
  const genres = new Set(planifierCoupures(99, { ...PROFIL, points: 40 }).map((p) => p.kind));
  assert.deepEqual([...genres].sort(), [...Object.values(CRASH_KINDS)].sort());
});

test("une écriture déchirée ne coupe ni à zéro octet ni au bloc entier", () => {
  // Zéro octet laisserait le bloc INTACT et le bloc entier le laisserait COMPLET : ni l'un ni
  // l'autre ne déchire quoi que ce soit, et le point ne prouverait rien.
  const dechirures = planifierCoupures(31, { ...PROFIL, points: 60 }).filter(
    (point) => point.kind === CRASH_KINDS.torn,
  );
  assert.ok(dechirures.length > 0, "la graine doit produire au moins une déchirure");
  for (const point of dechirures) {
    assert.equal(point.operation, "write");
    assert.ok(point.bytes >= 1 && point.bytes <= PROFIL.tailleBloc - 1, `bytes=${point.bytes}`);
  }
});

test("aucun point ne vise une opération que le scénario n'émet pas", () => {
  const profil = { ...PROFIL, points: 50, lectures: 6 };
  const bornes = { read: profil.lectures, write: profil.ecritures, flush: profil.barrieres };
  for (const point of planifierCoupures(5, profil)) {
    assert.ok(
      point.occurrence <= bornes[point.operation],
      `${point.operation}#${point.occurrence} > ${bornes[point.operation]}`,
    );
  }
});

test("sans lecture au programme, aucun point ne coupe sur une lecture", () => {
  // Le scénario d'écriture de `crash-scenario.mjs` ne lit rien : un point posé sur `read` ne serait
  // jamais atteint, et une faute jamais atteinte ne prouve rien (`FaultPlan#unfired`).
  const operations = new Set(
    planifierCoupures(11, { ...PROFIL, points: 60, lectures: 0 }).map((p) => p.operation),
  );
  assert.equal(operations.has("read"), false);
});

test("un arrêt brutal ne vise jamais une barrière : c'est l'autre genre qui la nomme", () => {
  // Confondre les deux effacerait la seule différence qui intéresse #16 : une écriture acquittée
  // n'est pas une écriture durable, et c'est la barrière qui les sépare.
  for (const point of planifierCoupures(13, { ...PROFIL, points: 80, lectures: 4 })) {
    if (point.kind === CRASH_KINDS.abrupt) assert.notEqual(point.operation, "flush");
    if (point.kind === CRASH_KINDS.beforeBarrier) assert.equal(point.operation, "flush");
  }
});

test("un profil incohérent est refusé plutôt qu'arrondi", () => {
  assert.throws(() => planifierCoupures(1.5, PROFIL), /graine/i);
  assert.throws(() => planifierCoupures(-1, PROFIL), /graine/i);
  assert.throws(() => planifierCoupures(1, { ...PROFIL, points: 0 }), /points/i);
  assert.throws(() => planifierCoupures(1, { ...PROFIL, ecritures: 0 }), /écritures/i);
  assert.throws(() => planifierCoupures(1, { ...PROFIL, barrieres: 0 }), /barrières/i);
});

test("un arrêt brutal s'arme en handle perdu : l'opération visée et toutes les suivantes échouent", () => {
  const point = {
    graine: 1,
    index: 0,
    kind: CRASH_KINDS.abrupt,
    operation: "write",
    occurrence: 5,
  };
  const plan = armerInjecteur(point);
  for (let rang = 1; rang < 5; rang += 1) assert.equal(plan.consume("write"), null);
  const faute = plan.consume("write");
  assert.equal(faute.kind, FAULT_KINDS.lostHandle);
});

test("une écriture déchirée s'arme en écriture partielle du nombre d'octets publié", () => {
  const point = {
    graine: 1,
    index: 0,
    kind: CRASH_KINDS.torn,
    operation: "write",
    occurrence: 2,
    bytes: 192,
  };
  const plan = armerInjecteur(point);
  plan.consume("write");
  const faute = plan.consume("write");
  assert.equal(faute.kind, FAULT_KINDS.partialWrite);
  assert.equal(faute.bytes, 192);
});

test("une coupure entre écriture et barrière s'arme sur la barrière, pas sur l'écriture", () => {
  const point = {
    graine: 1,
    index: 0,
    kind: CRASH_KINDS.beforeBarrier,
    operation: "flush",
    occurrence: 1,
  };
  const plan = armerInjecteur(point);
  assert.equal(plan.consume("write"), null);
  assert.equal(plan.consume("flush").kind, FAULT_KINDS.lostHandle);
});

test("un point inventé est refusé à l'armement", () => {
  assert.throws(
    () =>
      armerInjecteur({ graine: 1, index: 0, kind: "sabotage", operation: "write", occurrence: 1 }),
    /genre de coupure inconnu/i,
  );
});
