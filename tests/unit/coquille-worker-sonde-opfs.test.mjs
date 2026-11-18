import assert from "node:assert/strict";
import { register } from "node:module";
import test, { after } from "node:test";

import { TYPES_PRIVILEGIES, enveloppeDeMessage } from "../../src/coquille/contrat-de-messages.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// Le Worker de confiance, CHARGÉ TEL QUEL (#231) : WebKit 26.6+ expose `navigator.storage.getDirectory`
// mais le REJETTE (`UnknownError`) en contexte éphémère. Le Worker sonde donc l'OPFS par un appel, sans
// `await` de module (le Worker perdrait ses premiers messages). Ce que ces épreuves tiennent : AUCUNE
// réponse qui dépend de la capacité n'est construite avant que la sonde ait conclu — ni l'état, ni
// l'inventaire, ni un geste. Une demande reçue PENDANT la sonde doit recevoir la valeur d'APRÈS.

register("./support-resolution-web.mjs", import.meta.url);

/** Une promesse qu'on résout ou rejette à la main : la sonde, volontairement suspendue. */
function suspendue() {
  let resoudre;
  let rejeter;
  const promesse = new Promise((ok, ko) => {
    resoudre = ok;
    rejeter = ko;
  });
  return { promesse, resoudre, rejeter };
}

function rejet(nom) {
  const erreur = new Error("The operation failed for an unknown transient reason.");
  erreur.name = nom;
  return erreur;
}

const appels = { getDirectory: 0 };
const sonde = suspendue();
const postesGlobaux = [];

class FichierDouble {
  createSyncAccessHandle() {}
}
Object.defineProperty(globalThis, "FileSystemFileHandle", {
  value: FichierDouble,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: {
      getDirectory() {
        appels.getDirectory += 1;
        return sonde.promesse;
      },
    },
  },
  configurable: true,
  writable: true,
});
const ecouteurs = new Map();
Object.defineProperty(globalThis, "self", {
  value: {
    addEventListener: (type, fonction) => ecouteurs.set(type, fonction),
    postMessage: (message) => postesGlobaux.push(message),
  },
  configurable: true,
  writable: true,
});

await import("../../public/runtime-worker.mjs");

// La poignée de main, comme `canal-de-confiance.mjs` : deux ports transférés, dans cet ordre.
const privilegie = new MessageChannel();
const relais = new MessageChannel();
ecouteurs.get("message")({
  data: enveloppeDeMessage(TYPES_PRIVILEGIES.canal),
  ports: [privilegie.port2, relais.port2],
});
const recus = [];
privilegie.port1.on("message", (message) => recus.push(message));
privilegie.port1.unref();
relais.port1.unref();

after(() => {
  for (const port of [privilegie.port1, privilegie.port2, relais.port1, relais.port2]) port.close();
});

const attendre = (ms = 25) => new Promise((fini) => setTimeout(fini, ms));

test("la sonde est lancée une fois, et rien ne répond tant qu'elle n'a pas conclu", async () => {
  privilegie.port1.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.etat, { correlation: "e1" }));
  privilegie.port1.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.inventaire, { correlation: "i1" }),
  );
  privilegie.port1.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.deverrouiller, {
      correlation: "d1",
      moyen: "phrase",
      phrase: "une phrase qui ne sera pas dérivée",
    }),
  );
  await attendre(100);
  assert.equal(appels.getDirectory, 1, "la sonde appelle getDirectory() une fois");
  assert.deepEqual(
    recus.map((message) => message.correlation),
    [],
    "aucune réponse dépendante de la capacité avant la conclusion de la sonde",
  );
});

test("la sonde conclut `indisponible` : l'état, l'inventaire et le geste en tiennent compte", async () => {
  sonde.rejeter(rejet("UnknownError"));
  await attendre(150);
  const parCorrelation = new Map(recus.map((message) => [message.correlation, message]));

  const etat = parCorrelation.get("e1");
  assert.ok(etat, "la demande d'état posée PENDANT la sonde reçoit une réponse");
  assert.equal(etat.etat, "indisponible", "jamais la valeur périmée `verrouille`");
  assert.equal(
    recus.some((message) => message.etat === "verrouille"),
    false,
    "aucune réponse « verrouillé » n'est jamais publiée",
  );

  const inventaire = parCorrelation.get("i1");
  assert.ok(inventaire, "l'inventaire demandé PENDANT la sonde reçoit une réponse");
  assert.equal(inventaire.present, false);

  const geste = parCorrelation.get("d1");
  assert.ok(geste, "le geste présenté PENDANT la sonde reçoit un refus typé");
  assert.equal(geste.type, TYPES_PRIVILEGIES.refus);
  assert.equal(geste.code, STORAGE_ERROR_CODES.unsupported);
  assert.equal(appels.getDirectory, 1, "aucun accès à l'OPFS n'a eu lieu pour le geste");
});

test("une demande d'état APRÈS la conclusion rend aussi `indisponible`", async () => {
  recus.length = 0;
  privilegie.port1.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.etat, { correlation: "e2" }));
  await attendre(100);
  const etat = recus.find((message) => message.correlation === "e2");
  assert.equal(etat?.etat, "indisponible");
});
