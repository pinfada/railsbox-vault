import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluerPhrase,
  exigerPhraseDeCreation,
  CODE_PHRASE_FAIBLE,
} from "../../src/coquille/politique-de-phrase.mjs";
import { derivationsDeLaPage } from "../../src/coquille/derivation-dans-la-page.mjs";

test("création : phrases courtes, espaces, répétitions et suites sont refusés", () => {
  for (const phrase of [
    "",
    "a",
    "           a",
    "abcdefghijk",
    "aaaaaaaaaaaa",
    "abcdabcdabcd",
    "12345678901234567890",
    "😀".repeat(6),
  ]) {
    assert.equal(evaluerPhrase(phrase).admise, false);
    assert.throws(() => exigerPhraseDeCreation(phrase), { code: CODE_PHRASE_FAIBLE });
  }
  for (const phrase of ["Orbite-tulip!", "  douze lettres ici  ", "cèdre rivière cuivre nuage"]) {
    assert.equal(evaluerPhrase(phrase).admise, true);
  }
  assert.equal(evaluerPhrase("Orbite-tulip!").admise, true, "borne exacte de douze caractères");
});

test("le chemin de dérivation refuse un nouveau secret faible avant toute préparation", async () => {
  let appele = false;
  const page = derivationsDeLaPage({
    demanderAuWorker: async () => {
      appele = true;
      throw new Error("appel inattendu");
    },
    urlDuWorker: new URL("https://vault.example/derivation-worker.mjs"),
  });
  await assert.rejects(page.deriverPhrase({ inventaire: { present: false }, phrase: "a" }), {
    code: CODE_PHRASE_FAIBLE,
  });
  assert.equal(appele, false);
});

test("une phrase historique courte atteint encore le Worker de dérivation", async (t) => {
  const messages = [];
  class WorkerTemoin {
    addEventListener(type, ecoute) {
      if (type === "message") this.repondre = ecoute;
    }
    terminate() {}
    postMessage(message) {
      messages.push(message);
      this.repondre({ data: { ok: true, kek: "temoin", parametresHex: "00" } });
    }
  }
  const avant = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { value: WorkerTemoin, configurable: true });
  t.after(() => {
    if (avant) Object.defineProperty(globalThis, "Worker", avant);
    else delete globalThis.Worker;
  });
  const page = derivationsDeLaPage({
    demanderAuWorker: () => assert.fail("pas de création"),
    urlDuWorker: new URL("https://vault.example/worker.mjs"),
  });
  await page.deriverPhrase({
    inventaire: {
      present: true,
      emplacements: [{ typeKek: 1, parametresHex: "00", identifiantEmplacement: "01" }],
    },
    phrase: "a",
  });
  assert.equal(messages[0].phrase, "a");
});
