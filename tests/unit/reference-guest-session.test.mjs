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
  assert.throws(
    () => createReferenceGuestSession({ ...baseOptions(), V86: undefined }),
    /classe V86/,
  );
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

/** Émulateur muet : il se construit, n'expose jamais de contrôleur IDE et n'émet rien. */
function V86Muet() {
  this.add_listener = () => {};
  this.v86 = { cpu: { devices: {} } };
  this.run = () => {};
  this.stop = () => {};
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("le délai de garde du boot expire même quand les minuteries sont affamées", async () => {
  // Cas mesuré sous WebKit (#74, revue de la PR #86) : sous une boucle serrée de messages de canal,
  // aucune minuterie de ce Worker ne s'exécute. Le `setInterval` sur lequel reposait l'attente ne
  // tournerait donc pas pendant la plage qu'elle borne, et un boot qui n'aboutit pas resterait
  // suspendu sans jamais rendre de `BootTimeout` — un silence, exactement ce que #52 combat.
  //
  // L'épreuve n'est pas creuse : la cadence injectée REMPLACE la minuterie interne. Tant que
  // l'épreuve ne bat pas, rien ne doit trancher — c'est ce que la première assertion vérifie.
  let battre = null;
  const session = createReferenceGuestSession({
    ...baseOptions(),
    V86: V86Muet,
    artifacts: {
      wasm: new Uint8Array(0),
      bios: new Uint8Array(0),
      vgaBios: new Uint8Array(0),
      kernel: new Uint8Array(0),
      initrd: new Uint8Array(0),
      rootfs: new Uint8Array(0),
    },
    cadence: (rappel) => {
      battre = rappel;
      return () => {
        battre = null;
      };
    },
  });

  const echec = session.boot({ ideTimeoutMs: 5 }).then(
    () => null,
    (erreur) => erreur,
  );
  await pause(80);
  assert.equal(
    await Promise.race([echec.then(() => "reglee"), pause(20).then(() => "pendante")]),
    "pendante",
    "sans battement, aucune minuterie ne doit trancher : la cadence est la seule source",
  );

  battre();
  const erreur = await echec;
  assert.equal(erreur?.name, "BootTimeout");
  assert.match(erreur.message, /contrôleur IDE/);
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
