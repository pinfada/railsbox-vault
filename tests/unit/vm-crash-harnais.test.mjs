import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNAIS_RESILIENCE_ENV,
  HARNAIS_RESILIENCE_JETON,
  HARNAIS_RESILIENCE_VALEUR,
  exigerHarnaisResilience,
} from "../../src/vm/crash-harness.mjs";

// Ce fichier ne pose JAMAIS la variable du harnais : c'est tout son objet. `node --test` exécute
// chaque fichier dans son propre processus, si bien que l'armement autorisé ailleurs
// (`vm-crash-matrice.test.mjs`) ne fuit pas ici.

test("hors harnais, l'injecteur d'arrêts refuse de s'armer, bruyamment", () => {
  assert.equal(process.env[HARNAIS_RESILIENCE_ENV], undefined);
  assert.throws(() => exigerHarnaisResilience(), /harnais de résilience/);
  // Le jeton du navigateur ne rachète pas une absence de variable sous Node : les deux chemins ne
  // se remplacent pas l'un l'autre, sinon la garde du processus serait contournable par un argument.
  assert.throws(
    () => exigerHarnaisResilience({ jeton: HARNAIS_RESILIENCE_JETON }),
    /harnais de résilience/,
  );
});

test("une valeur approchante de la variable ne suffit pas", () => {
  process.env[HARNAIS_RESILIENCE_ENV] = "oui";
  try {
    assert.throws(() => exigerHarnaisResilience(), /harnais de résilience/);
    process.env[HARNAIS_RESILIENCE_ENV] = `${HARNAIS_RESILIENCE_VALEUR} `;
    assert.throws(() => exigerHarnaisResilience(), /harnais de résilience/);
  } finally {
    delete process.env[HARNAIS_RESILIENCE_ENV];
  }
});

test("la variable exacte du harnais autorise l'armement", () => {
  process.env[HARNAIS_RESILIENCE_ENV] = HARNAIS_RESILIENCE_VALEUR;
  try {
    assert.doesNotThrow(() => exigerHarnaisResilience());
  } finally {
    delete process.env[HARNAIS_RESILIENCE_ENV];
  }
});

test("sans processus — un Worker de navigateur — seul le jeton exact autorise l'armement", () => {
  // `exigerHarnaisResilience` lit `globalThis.process`. Un Worker n'en a pas : le contexte est
  // simulé en le masquant, ce qui est la seule façon d'éprouver cette branche sous Node.
  const reel = globalThis.process;
  try {
    delete globalThis.process;
    assert.throws(() => exigerHarnaisResilience(), /harnais de résilience/);
    assert.throws(() => exigerHarnaisResilience({ jeton: "vault/autre" }), /harnais de résilience/);
    assert.doesNotThrow(() => exigerHarnaisResilience({ jeton: HARNAIS_RESILIENCE_JETON }));
  } finally {
    globalThis.process = reel;
  }
});
