import assert from "node:assert/strict";
import { register } from "node:module";
import test, { after } from "node:test";

import { TYPES_PRIVILEGIES, enveloppeDeMessage } from "../../src/coquille/contrat-de-messages.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// Le Worker de confiance, CHARGÉ TEL QUEL (#231) : WebKit 26.6+ expose `navigator.storage.getDirectory`
// mais le REJETTE (`UnknownError`) en contexte éphémère. Le Worker sonde donc l'OPFS par un appel, sans
// `await` de module (un Worker module perdrait ses premiers messages). Ce que ces épreuves tiennent :
// AUCUNE réponse qui dépend de la capacité n'est construite avant que la sonde ait conclu — ni l'état,
// ni l'inventaire, ni un geste. Une demande reçue PENDANT la sonde reçoit la valeur d'APRÈS, et seul un
// rejet qui SIGNE l'absence pose `indisponible`.

register("./support-resolution-web.mjs", import.meta.url);

const attendre = (ms = 25) => new Promise((fini) => setTimeout(fini, ms));

function rejet(nom) {
  const erreur = new Error("The operation failed for an unknown transient reason.");
  erreur.name = nom;
  return erreur;
}

const aFermer = [];
after(() => {
  for (const port of aFermer) port.close();
});

let numero = 0;

/**
 * Monte UN Worker neuf (une instance de module par cas) dont `getDirectory()` est une promesse que
 * l'épreuve tient en main, et établit le canal comme le fait `canal-de-confiance.mjs`.
 */
async function monterLeWorker() {
  let resoudre;
  let rejeter;
  const sonde = new Promise((ok, ko) => {
    resoudre = ok;
    rejeter = ko;
  });
  const appels = { getDirectory: 0 };
  const ecouteurs = new Map();
  class FichierDouble {
    createSyncAccessHandle() {}
  }
  const poser = (nom, valeur) =>
    Object.defineProperty(globalThis, nom, { value: valeur, configurable: true, writable: true });
  poser("FileSystemFileHandle", FichierDouble);
  poser("navigator", {
    storage: {
      getDirectory() {
        appels.getDirectory += 1;
        return sonde;
      },
    },
  });
  poser("self", {
    addEventListener: (type, fonction) => ecouteurs.set(type, fonction),
    postMessage() {},
  });
  numero += 1;
  await import(`../../public/runtime-worker.mjs?cas=${numero}`);

  const privilegie = new MessageChannel();
  const relais = new MessageChannel();
  aFermer.push(privilegie.port1, privilegie.port2, relais.port1, relais.port2);
  ecouteurs.get("message")({
    data: enveloppeDeMessage(TYPES_PRIVILEGIES.canal),
    ports: [privilegie.port2, relais.port2],
  });
  const recus = [];
  privilegie.port1.on("message", (message) => recus.push(message));
  privilegie.port1.unref();
  relais.port1.unref();

  const envoyer = (type, correlation, corps = {}) =>
    privilegie.port1.postMessage(enveloppeDeMessage(type, { correlation, ...corps }));
  const parCorrelation = (correlation) =>
    recus.find((message) => message.correlation === correlation);
  return {
    appels,
    recus,
    envoyer,
    parCorrelation,
    resoudre: () => resoudre({}),
    rejeter: (nom) => rejeter(rejet(nom)),
  };
}

function poserLesTroisDemandes(worker) {
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  worker.envoyer(TYPES_PRIVILEGIES.inventaire, "i1");
  worker.envoyer(TYPES_PRIVILEGIES.deverrouiller, "d1", {
    moyen: "phrase",
    phrase: "une phrase qui ne sera pas dérivée",
  });
}

test("la sonde est lancée une fois, et rien ne répond tant qu'elle n'a pas conclu", async () => {
  const worker = await monterLeWorker();
  poserLesTroisDemandes(worker);
  await attendre(100);
  assert.equal(worker.appels.getDirectory, 1, "la sonde appelle getDirectory() une fois");
  assert.deepEqual(
    worker.recus.map((message) => message.correlation),
    [],
    "aucune réponse dépendante de la capacité avant la conclusion de la sonde",
  );
});

test("UnknownError : l'état, l'inventaire et le geste présentés PENDANT la sonde en tiennent compte", async () => {
  const worker = await monterLeWorker();
  poserLesTroisDemandes(worker);
  await attendre(50);
  worker.rejeter("UnknownError");
  await attendre(150);

  const etat = worker.parCorrelation("e1");
  assert.ok(etat, "la demande d'état posée PENDANT la sonde reçoit une réponse");
  assert.equal(etat.etat, "indisponible", "jamais la valeur périmée `verrouille`");
  assert.equal(
    worker.recus.some((message) => message.etat === "verrouille"),
    false,
    "aucune réponse « verrouillé » n'est jamais publiée",
  );

  const inventaire = worker.parCorrelation("i1");
  assert.ok(inventaire, "l'inventaire demandé PENDANT la sonde reçoit une réponse");
  assert.equal(inventaire.present, false);

  const geste = worker.parCorrelation("d1");
  assert.ok(geste, "le geste présenté PENDANT la sonde reçoit un refus typé");
  assert.equal(geste.type, TYPES_PRIVILEGIES.refus);
  assert.equal(geste.code, STORAGE_ERROR_CODES.unsupported);
  assert.equal(worker.appels.getDirectory, 1, "aucun accès à l'OPFS n'a eu lieu pour le geste");

  worker.envoyer(TYPES_PRIVILEGIES.etat, "e2");
  await attendre(75);
  assert.equal(worker.parCorrelation("e2")?.etat, "indisponible", "et APRÈS la conclusion aussi");
});

test("une sonde qui ABOUTIT laisse l'état `verrouille`, présenté pendant ou après", async () => {
  const worker = await monterLeWorker();
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  await attendre(50);
  assert.equal(worker.parCorrelation("e1"), undefined, "rien avant la conclusion");
  worker.resoudre();
  await attendre(100);
  assert.equal(worker.parCorrelation("e1")?.etat, "verrouille");
});

test("une PANNE (autre rejet que l'absence) n'est PAS « indisponible » : l'état reste `verrouille`", async () => {
  for (const nom of ["QuotaExceededError", "InvalidStateError", "Error"]) {
    const worker = await monterLeWorker();
    worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
    worker.rejeter(nom);
    await attendre(100);
    assert.equal(worker.parCorrelation("e1")?.etat, "verrouille", nom);
  }
});
