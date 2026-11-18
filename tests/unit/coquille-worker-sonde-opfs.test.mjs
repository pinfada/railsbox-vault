import assert from "node:assert/strict";
import { register } from "node:module";
import test, { after } from "node:test";

import { TYPES_PRIVILEGIES, enveloppeDeMessage } from "../../src/coquille/contrat-de-messages.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// Le Worker de confiance, CHARGÉ TEL QUEL (#231, revues de la PR #305). WebKit 26.6+ expose
// `navigator.storage.getDirectory` mais le REJETTE (`UnknownError`, message « … unknown transient
// reason (e.g. out of memory). ») en contexte éphémère. Le Worker sonde donc l'OPFS par un appel, sans
// `await` de module (un Worker module perdrait ses premiers messages). Ce que ces épreuves tiennent :
//
//  - AUCUNE réponse qui dépend de la capacité n'est construite avant que la sonde ait conclu ;
//  - un `UnknownError` n'est PAS une absence : la sonde réessaie un nombre borné de fois, et s'il
//    persiste l'état est `indetermine` — « inaccessible pour l'instant, cause non établie » —, refusé
//    `VAULT_STORAGE_INDETERMINE`, jamais `indisponible` ni `VAULT_STORAGE_UNSUPPORTED` ;
//  - RIEN n'est figé : un geste présenté ensuite relance la sonde, et si elle aboutit le coffre est
//    `verrouille` sans rechargement ;
//  - seuls les refus de capacité déjà typés (`SecurityError`) posent `indisponible`.

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
 * Monte UN Worker neuf (une instance de module par cas). `getDirectory()` suit `comportement(n)`, où
 * `n` compte les appels depuis 1 : il rend une promesse, que l'épreuve tient en main si elle le veut.
 */
async function monterLeWorker(comportement) {
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
        return comportement(appels.getDirectory);
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
  return {
    appels,
    recus,
    envoyer,
    parCorrelation: (correlation) => recus.find((message) => message.correlation === correlation),
  };
}

const toujoursRejete = (nom) => () => Promise.reject(rejet(nom));

function geste(worker, correlation) {
  worker.envoyer(TYPES_PRIVILEGIES.deverrouiller, correlation, {
    moyen: "phrase",
    phrase: "une phrase qui ne sera pas dérivée",
  });
}

test("rien ne répond tant que la sonde n'a pas conclu, et elle est lancée une fois", async () => {
  let ouvrir;
  const suspendue = new Promise((ok) => {
    ouvrir = ok;
  });
  const worker = await monterLeWorker((n) => (n === 1 ? suspendue : Promise.resolve({})));
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  worker.envoyer(TYPES_PRIVILEGIES.inventaire, "i1");
  geste(worker, "d1");
  await attendre(100);
  assert.equal(worker.appels.getDirectory, 1, "la sonde appelle getDirectory() une fois");
  assert.deepEqual(
    worker.recus.map((message) => message.correlation),
    [],
    "aucune réponse dépendante de la capacité avant la conclusion de la sonde",
  );
  ouvrir({});
  await attendre(100);
  assert.equal(worker.parCorrelation("e1")?.etat, "verrouille");
});

test("UnknownError PERSISTANT : l'état est `indetermine` — jamais `verrouille`, jamais `indisponible`", async () => {
  const worker = await monterLeWorker(toujoursRejete("UnknownError"));
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  worker.envoyer(TYPES_PRIVILEGIES.inventaire, "i1");
  geste(worker, "d1");
  await attendre(900);

  const etat = worker.parCorrelation("e1");
  assert.ok(etat, "la demande d'état posée PENDANT la sonde reçoit une réponse");
  assert.equal(etat.etat, "indetermine");
  for (const interdit of ["verrouille", "indisponible"]) {
    assert.equal(
      worker.recus.some((message) => message.etat === interdit),
      false,
      `aucune réponse « ${interdit} » n'est publiée pour un rejet qui ne prouve pas l'absence`,
    );
  }

  assert.equal(worker.parCorrelation("i1")?.present, false);

  const refus = worker.parCorrelation("d1");
  assert.ok(refus, "le geste présenté PENDANT la sonde reçoit un refus typé");
  assert.equal(refus.type, TYPES_PRIVILEGIES.refus);
  assert.equal(refus.code, STORAGE_ERROR_CODES.indeterminate);
  assert.notEqual(refus.code, STORAGE_ERROR_CODES.unsupported);
  assert.ok(worker.appels.getDirectory >= 3, "la sonde a réessayé (essais bornés)");
  assert.ok(worker.appels.getDirectory <= 9, "et le nombre d'essais reste borné");
});

test("UnknownError TRANSITOIRE puis réussite : atteignable, rien de figé", async () => {
  const worker = await monterLeWorker((n) =>
    n <= 2 ? Promise.reject(rejet("UnknownError")) : Promise.resolve({}),
  );
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  await attendre(400);
  assert.equal(worker.parCorrelation("e1")?.etat, "verrouille");
  assert.equal(worker.appels.getDirectory, 3);
});

test("un geste présenté APRÈS l'indéterminé relance la sonde : si elle aboutit, `verrouille` sans rechargement", async () => {
  const worker = await monterLeWorker((n) =>
    n <= 3 ? Promise.reject(rejet("UnknownError")) : Promise.resolve({}),
  );
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  await attendre(400);
  assert.equal(worker.parCorrelation("e1")?.etat, "indetermine");

  geste(worker, "d1");
  await attendre(250);
  const reponse = worker.parCorrelation("d1");
  assert.ok(reponse, "le geste reçoit une réponse");
  assert.notEqual(reponse.code, STORAGE_ERROR_CODES.indeterminate, "la sonde l'a levé");
  assert.notEqual(reponse.code, STORAGE_ERROR_CODES.unsupported);

  worker.envoyer(TYPES_PRIVILEGIES.etat, "e2");
  await attendre(100);
  assert.equal(worker.parCorrelation("e2")?.etat, "verrouille");
});

test("un refus de capacité déjà TYPÉ (SecurityError) reste une absence : `indisponible`, UNSUPPORTED, sans réessai", async () => {
  const worker = await monterLeWorker(toujoursRejete("SecurityError"));
  worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
  geste(worker, "d1");
  await attendre(150);
  assert.equal(worker.parCorrelation("e1")?.etat, "indisponible");
  assert.equal(worker.parCorrelation("d1")?.code, STORAGE_ERROR_CODES.unsupported);
  assert.equal(worker.appels.getDirectory, 1);
});

test("une PANNE (autre rejet) n'est ni absente ni indéterminée : l'état reste `verrouille`, sans réessai", async () => {
  for (const nom of ["QuotaExceededError", "InvalidStateError", "Error"]) {
    const worker = await monterLeWorker(toujoursRejete(nom));
    worker.envoyer(TYPES_PRIVILEGIES.etat, "e1");
    await attendre(100);
    assert.equal(worker.parCorrelation("e1")?.etat, "verrouille", nom);
    assert.equal(worker.appels.getDirectory, 1, nom);
  }
});
