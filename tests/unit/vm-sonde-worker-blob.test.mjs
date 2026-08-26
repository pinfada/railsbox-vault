// Sonde de Worker `blob:` du contrôle préalable (#52, hygiène #85).
//
// Ce que ces épreuves fixent tient en une phrase : la sonde mesure un SIGNE DE VIE, et elle ne
// révoque l'URL de l'objet qu'après l'avoir obtenu — ou après son délai. Révoquer dans un `finally`
// accolé à `new Worker` laissait une fenêtre étroite où un moteur strict aurait pu faire échouer le
// chargement du blob ; ce faux refus se serait lu comme un refus de CSP, c'est-à-dire comme la panne
// même que #52 diagnostique.
//
// Elles s'exécutent sous Node : la sonde reçoit son contexte en paramètre, un faux `URL`, `Blob` et
// `Worker` suffisent donc à observer l'ORDRE des gestes, sans navigateur.

import assert from "node:assert/strict";
import test from "node:test";

import { sonderWorkerBlob } from "../../src/vm/runtime-environment.mjs";

const URL_BLOB = "blob:faux/1";

/**
 * Faux contexte de Worker. Il journalise les gestes dans l'ordre où ils surviennent — c'est le seul
 * fait que ces épreuves mesurent — et laisse chacune décider ce que le Worker fait ensuite.
 *
 * @param {{ conduite?: (worker: object) => void, construction?: () => void }} [options]
 */
function faireContexte({ conduite = () => {}, construction = () => {} } = {}) {
  const journal = [];
  const contexte = {
    journal,
    Blob: class {
      constructor(parties) {
        this.parties = parties;
      }
    },
    URL: {
      createObjectURL: () => {
        journal.push("createObjectURL");
        return URL_BLOB;
      },
      revokeObjectURL: (url) => {
        assert.equal(url, URL_BLOB);
        journal.push("revokeObjectURL");
      },
    },
    setTimeout: (rappel, delai) => setTimeout(rappel, delai),
    clearTimeout: (identifiant) => clearTimeout(identifiant),
    Worker: class {
      constructor(url) {
        assert.equal(url, URL_BLOB);
        journal.push("new Worker");
        construction();
        this.ecouteurs = new Map();
        // Le signe de vie arrive au tour suivant : un Worker réel ne poste jamais dans son
        // constructeur, et l'épreuve doit traverser la même attente que le code de production.
        queueMicrotask(() => conduite(this));
      }
      addEventListener(type, rappel) {
        this.ecouteurs.set(type, rappel);
      }
      emettre(type, evenement) {
        this.ecouteurs.get(type)?.(evenement);
      }
      terminate() {
        journal.push("terminate");
      }
    },
  };
  return contexte;
}

test("l'URL de l'objet n'est révoquée qu'APRÈS le premier signe de vie", async () => {
  const contexte = faireContexte({ conduite: (worker) => worker.emettre("message", {}) });

  const resultat = await sonderWorkerBlob({ contexte });

  assert.equal(resultat, "vivant");
  // C'est l'ORDRE qui est en jeu, pas la présence : révoquer entre la construction et le premier
  // message rendrait un « refusé » que rien dans la CSP n'aurait causé.
  assert.deepEqual(contexte.journal, [
    "createObjectURL",
    "new Worker",
    "terminate",
    "revokeObjectURL",
  ]);
});

test("un Worker muet fait révoquer l'URL après le délai, et rend le silence", async () => {
  // C'est le cas mesuré sous `worker-src 'self'` : le constructeur ne lève pas, l'objet est inerte.
  const contexte = faireContexte();

  const resultat = await sonderWorkerBlob({ contexte, delaiMs: 5 });

  assert.equal(resultat, "aucun message reçu");
  assert.deepEqual(contexte.journal, [
    "createObjectURL",
    "new Worker",
    "terminate",
    "revokeObjectURL",
  ]);
});

test("un Worker qui émet une erreur est nommé, et l'URL est révoquée ensuite", async () => {
  const contexte = faireContexte({
    conduite: (worker) => worker.emettre("error", { message: "script refusé" }),
  });

  const resultat = await sonderWorkerBlob({ contexte, delaiMs: 50 });

  assert.equal(resultat, "erreur du Worker : script refusé");
  assert.deepEqual(contexte.journal, [
    "createObjectURL",
    "new Worker",
    "terminate",
    "revokeObjectURL",
  ]);
});

test("un refus À LA CONSTRUCTION révoque quand même l'URL, et ne fuit pas", async () => {
  const contexte = faireContexte({
    construction: () => {
      const erreur = new Error("worker-src");
      erreur.name = "SecurityError";
      throw erreur;
    },
  });

  const resultat = await sonderWorkerBlob({ contexte });

  assert.equal(resultat, "refusé à la construction : SecurityError");
  assert.deepEqual(contexte.journal, ["createObjectURL", "new Worker", "revokeObjectURL"]);
});
