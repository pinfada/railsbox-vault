// Le message d'une erreur non rattrapée d'un Worker de banc (#243) : il dit toujours quelque chose.

import assert from "node:assert/strict";
import test from "node:test";

import { messageDErreurDuWorker } from "../../public/vm/erreur-du-worker.mjs";

test("un Worker mort SANS message n'est plus publié « undefined »", () => {
  const message = messageDErreurDuWorker("runtime", { type: "error", message: undefined });
  assert.doesNotMatch(message, /undefined/);
  assert.equal(
    message,
    "Erreur du Worker runtime : erreur du Worker sans message (mort du Worker, mémoire ?)" +
      " — événement « error »",
  );
});

test("un message vide compte comme une absence de message", () => {
  assert.match(messageDErreurDuWorker("runtime", { type: "error", message: "  " }), /sans message/);
});

test("un événement absent est décrit, pas rejeté", () => {
  assert.match(messageDErreurDuWorker("runtime", undefined), /sans message.*« inconnu »/);
});

test("avec un message, le fichier, la ligne et la colonne suivent quand ils existent", () => {
  assert.equal(
    messageDErreurDuWorker("runtime", {
      type: "error",
      message: "Uncaught RangeError: Array buffer allocation failed",
      filename: "http://127.0.0.1:4173/vm/runtime-worker.mjs",
      lineno: 12,
      colno: 7,
    }),
    "Erreur du Worker runtime : Uncaught RangeError: Array buffer allocation failed" +
      " (http://127.0.0.1:4173/vm/runtime-worker.mjs:12:7)",
  );
});

test("avec un message et sans fichier, le message est rendu seul", () => {
  assert.equal(
    messageDErreurDuWorker("runtime", { type: "error", message: "boom", filename: "" }),
    "Erreur du Worker runtime : boom",
  );
});
