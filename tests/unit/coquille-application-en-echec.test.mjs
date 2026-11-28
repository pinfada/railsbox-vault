// Une application qui n'a jamais répondu : la coquille le DIT, avec sa cause (#351, ADR 0055).
//
// Avant, un boot dont Rails ne répondait pas levait une exception que le Worker rendait en
// « L'opération n'a pas abouti, sans cause identifiée », après cinq minutes — ou, sur un volume neuf,
// en « installation inachevée » alors que l'installation avait abouti.

import assert from "node:assert/strict";
import test from "node:test";

import { applicationEnEchec } from "../../src/coquille/installation-interrompue.mjs";
import { conduiteDuDemarrageEchoue } from "../../src/coquille/cause-du-demarrage.mjs";
import { conduiteHumaine } from "../../src/coquille/conduites-du-parcours.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";

test("une erreur qui porte sa cause en clair devient un démarrage refusé, typé, avec son motif", () => {
  const erreur = new Error("Rails n'a pas répondu");
  erreur.causeEnClair = "L'application s'est arrêtée pendant son démarrage.";
  assert.deepEqual(applicationEnEchec(erreur), {
    demarree: false,
    code: C.applicationEnEchec,
    motif: "L'application s'est arrêtée pendant son démarrage.",
  });
});

test("une erreur sans cause en clair n'est pas une application en échec : elle suit son chemin", () => {
  assert.equal(applicationEnEchec(new Error("artefact refusé")), null);
  assert.equal(applicationEnEchec({ causeEnClair: "" }), null);
  assert.equal(applicationEnEchec(undefined), null);
});

test("la page dit la conduite, puis la cause", () => {
  const texte = conduiteDuDemarrageEchoue("Rails exige une clé secrète.");
  assert.ok(texte.startsWith(conduiteHumaine(C.applicationEnEchec)));
  assert.match(texte, /Cause : Rails exige une clé secrète\.$/);
  assert.equal(conduiteDuDemarrageEchoue(null), conduiteHumaine(C.applicationEnEchec));
});

test("la cause affichée est bornée et sans caractère de contrôle", () => {
  const texte = conduiteDuDemarrageEchoue(`a\u0007b\n${"x".repeat(2_000)}`);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(texte, /[\u0000-\u001f]/);
  assert.ok(texte.length < conduiteHumaine(C.applicationEnEchec).length + 620);
});
