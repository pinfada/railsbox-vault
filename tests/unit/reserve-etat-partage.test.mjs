/**
 * L'ÉTAT DE RÉVOCATION MONOTONE, partagé par toute la page (#299, ADR 0048 § 7, revue de #312).
 *
 * Garde éprouvée : 32 (non monotone : recalculé, remis à « inconnue », ou propre à chaque portail).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { creerEtatPartage } from "../../src/coquille/reserve-etat-partage.mjs";

test("l'état part de « inconnue » et passe à « connue » avec sa cause, `plancher` ou `retrait`", () => {
  const etat = creerEtatPartage();
  assert.equal(etat.connue(), false);
  assert.equal(etat.cause(), null);
  etat.noter("plancher");
  assert.equal(etat.connue(), true);
  assert.equal(etat.cause(), "plancher");
});

test("il ne REVIENT JAMAIS en arrière : aucune API ne l'efface, un recalcul « sans révocation » est sans effet", () => {
  const etat = creerEtatPartage();
  etat.noter("retrait");
  for (const nom of ["effacer", "reinitialiser", "reset", "oublier", "inconnue"]) {
    assert.equal(etat[nom], undefined, `l'état n'expose pas « ${nom} »`);
  }
  etat.noter(null);
  etat.noter(undefined);
  etat.noter("rien");
  assert.equal(etat.connue(), true);
  assert.equal(
    etat.cause(),
    "retrait",
    "la première cause est gardée : ni recalcul ni seconde cause ne la remplacent",
  );
  etat.noter("plancher");
  assert.equal(etat.cause(), "retrait");
});

test("seules les deux causes nommées sont admises : une cause inconnue ne rend pas l'état « connu »", () => {
  const etat = creerEtatPartage();
  for (const cause of ["", "autre", 42, {}, "PLANCHER"]) etat.noter(cause);
  assert.equal(etat.connue(), false);
});

test("deux états distincts ne se partagent RIEN : c'est la page qui n'en crée qu'un", () => {
  const a = creerEtatPartage();
  const b = creerEtatPartage();
  a.noter("plancher");
  assert.equal(b.connue(), false);
});

test("le changement de contrôleur est une anomalie MONOTONE de la même nature", () => {
  const etat = creerEtatPartage();
  assert.equal(etat.controleurChange(), false);
  etat.noterLeChangementDeControleur();
  assert.equal(etat.controleurChange(), true);
  assert.equal(etat.effacer, undefined);
});
