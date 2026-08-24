import assert from "node:assert/strict";
import { test } from "node:test";

import { BlockJournal } from "../../src/vm/block-journal.mjs";
import { createReferenceGuestSession } from "../../src/vm/reference-guest-session.mjs";

// La session de guest de référence exige que V86, les tampons et l'adaptateur soient INJECTÉS. Ces
// gardes protègent l'invariant central du module : il ne fabrique jamais lui-même une capacité
// absente et refuse tôt une configuration incomplète, plutôt que d'échouer obscurément au boot.

const baseOptions = () => ({
  V86: function V86Fictif() {},
  artifacts: { wasm: new Uint8Array(0) },
  appAdapter: { byteLength: 0 },
  journal: new BlockJournal(),
  cmdline: "root=/dev/sda rw console=ttyS0",
});

test("une classe V86 absente est refusée explicitement", () => {
  assert.throws(() => createReferenceGuestSession({ ...baseOptions(), V86: undefined }), /classe V86/);
});

test("un adaptateur applicatif absent est refusé explicitement", () => {
  assert.throws(
    () => createReferenceGuestSession({ ...baseOptions(), appAdapter: null }),
    /adaptateur applicatif/,
  );
});

test("une ligne de commande vide est refusée explicitement", () => {
  assert.throws(
    () => createReferenceGuestSession({ ...baseOptions(), cmdline: "" }),
    /ligne de commande/,
  );
});

test("une configuration complète construit la session sans démarrer de VM", () => {
  const session = createReferenceGuestSession(baseOptions());
  assert.equal(typeof session.boot, "function");
  assert.equal(typeof session.awaitHealth, "function");
  assert.equal(typeof session.request, "function");
  assert.equal(typeof session.stop, "function");
  // Aucune VM n'a démarré : le transcript est vide et `stop` reste sans effet.
  assert.equal(session.transcript(), "");
  session.stop();
});
