import assert from "node:assert/strict";
import test from "node:test";

import { CLASSES, VERDICTS, classerVolume } from "../../src/vm/crash-oracle.mjs";

// L'oracle est une fonction PURE : il reçoit ce qui a été relu du support et ce qui était attendu,
// et il classe. Les octets observés sont donc fabriqués ici, ce qui est la seule façon d'exercer
// les quatre classes — un support réel ne produit pas une corruption à la demande. Le même oracle
// est ensuite appliqué à des relectures RÉELLES par `vm-crash-matrice.test.mjs` (backend OPFS sur
// le double) et par `tests/vm/resilience-arrets.spec.mjs` (OPFS de Chromium).

const TAILLE = 8;
const ancien = (n) => Uint8Array.from({ length: TAILLE }, (_, i) => (10 + n + i) % 256);
const nouveau = (n) => Uint8Array.from({ length: TAILLE }, (_, i) => (200 + n + i) % 256);

function bloc(index, observe) {
  return { index, offset: index * TAILLE, ancien: ancien(index), nouveau: nouveau(index), observe };
}

/** Bloc déchiré : la moitié basse porte le nouvel état, la moitié haute l'ancien. */
function dechire(index) {
  const octets = new Uint8Array(TAILLE);
  octets.set(nouveau(index).subarray(0, 4), 0);
  octets.set(ancien(index).subarray(4), 4);
  return octets;
}

test("un volume entièrement relu à l'ancien état est classé « ancien », sans raison à donner", () => {
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0)), bloc(1, ancien(1))] });
  assert.equal(rapport.verdict, VERDICTS.ancien);
  assert.equal(rapport.raison, null);
  assert.equal(rapport.atomique, true);
  assert.deepEqual(rapport.classes, { ancien: 2, nouveau: 0, dechire: 0, corrompu: 0 });
});

test("un volume entièrement relu au nouvel état est classé « nouveau »", () => {
  const rapport = classerVolume({ blocs: [bloc(0, nouveau(0)), bloc(1, nouveau(1))] });
  assert.equal(rapport.verdict, VERDICTS.nouveau);
  assert.equal(rapport.atomique, true);
});

test("des blocs anciens et nouveaux qui cohabitent donnent « melange », qui n'est PAS atomique", () => {
  const rapport = classerVolume({ blocs: [bloc(0, nouveau(0)), bloc(1, ancien(1))] });
  assert.equal(rapport.verdict, VERDICTS.melange);
  assert.equal(rapport.atomique, false);
  assert.match(rapport.raison, /cohabitent/);
  assert.deepEqual(rapport.classes, { ancien: 1, nouveau: 1, dechire: 0, corrompu: 0 });
});

test("un bloc dont une partie seulement porte le nouvel état est « dechire »", () => {
  const rapport = classerVolume({ blocs: [bloc(0, dechire(0)), bloc(1, ancien(1))] });
  assert.equal(rapport.blocs[0].classe, CLASSES.dechire);
  assert.equal(rapport.classes.dechire, 1);
  // Un bloc déchiré n'est NI l'ancien état NI le nouveau : au niveau du volume il rejoint
  // « corrompu ». Le compte par classe conserve la distinction, elle n'est pas perdue.
  assert.equal(rapport.verdict, VERDICTS.corrompu);
  assert.equal(rapport.atomique, false);
  assert.match(rapport.raison, /déchiré/);
});

test("un bloc que l'oracle ne sait rattacher à rien est « corrompu » AVEC diagnostic, jamais ignoré", () => {
  const etranger = new Uint8Array(TAILLE).fill(0x5a);
  const rapport = classerVolume({ blocs: [bloc(0, etranger)] });
  assert.equal(rapport.blocs[0].classe, CLASSES.corrompu);
  assert.equal(rapport.verdict, VERDICTS.corrompu);
  assert.ok(rapport.blocs[0].diagnostic, "un bloc corrompu doit porter un diagnostic");
  assert.match(rapport.blocs[0].diagnostic, /octet/);
});

test("une écriture acquittée PUIS franchie par une barrière, absente du support, est une corruption", () => {
  // C'est la promesse `SEC-DURABLE-001` lue à l'envers : le journal dit que l'écriture a été
  // acquittée et qu'une barrière l'a suivie ; le support rend pourtant l'ancien état. Classer cela
  // « ancien » serait un succès silencieux.
  const journal = [
    { seq: 0, operation: "write", offset: 0, length: TAILLE },
    { seq: 1, operation: "flush", barrier: 0 },
    { seq: 2, operation: "flush-ack", barrier: 0 },
  ];
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0))], journal });
  assert.equal(rapport.blocs[0].acquitte, true);
  assert.equal(rapport.blocs[0].durable, true);
  assert.equal(rapport.blocs[0].classe, CLASSES.corrompu);
  assert.match(rapport.blocs[0].diagnostic, /barrière/i);
});

test("une écriture acquittée mais JAMAIS franchie par une barrière peut légitimement être perdue", () => {
  const journal = [{ seq: 0, operation: "write", offset: 0, length: TAILLE }];
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0))], journal });
  assert.equal(rapport.blocs[0].acquitte, true);
  assert.equal(rapport.blocs[0].durable, false);
  assert.equal(rapport.blocs[0].classe, CLASSES.ancien);
  assert.equal(rapport.verdict, VERDICTS.ancien);
});

test("l'oracle refuse un bloc dont l'ancien et le nouveau contenu sont identiques", () => {
  // Il ne saurait pas les distinguer : le classer « ancien » ou « nouveau » serait un tirage au sort
  // présenté comme une mesure.
  assert.throws(
    () =>
      classerVolume({
        blocs: [{ index: 0, offset: 0, ancien: ancien(0), nouveau: ancien(0), observe: ancien(0) }],
      }),
    /indiscernables/i,
  );
});

test("des longueurs incohérentes sont refusées, jamais complétées", () => {
  assert.throws(
    () =>
      classerVolume({
        blocs: [{ index: 0, offset: 0, ancien: ancien(0), nouveau: nouveau(0), observe: new Uint8Array(4) }],
      }),
    /longueur/i,
  );
  assert.throws(() => classerVolume({ blocs: [] }), /aucun bloc/i);
});
