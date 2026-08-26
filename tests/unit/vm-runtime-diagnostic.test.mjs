// Diagnostic typé du runtime (#52). Ce que ces épreuves fixent : un contexte qui ne peut pas faire
// battre v86 produit un CODE, et ce code désigne la cause exacte — jamais une cause voisine, jamais
// un silence. Elles s'exécutent sous Node parce que le contrôle préalable reçoit son environnement
// en paramètre : la CSP n'a pas besoin d'être reproduite pour éprouver la décision qu'elle provoque.

import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_ERROR_CODES, RuntimeError, isRuntimeError } from "../../src/vm/runtime-errors.mjs";
import { surveillerPremierTour } from "../../src/vm/runtime-environment.mjs";
import {
  CHEMINS_ORDONNANCEMENT,
  cheminOrdonnancement,
  controlerRuntime,
} from "../../src/vm/runtime-preflight.mjs";

const URL_AVEC_MARQUEUR = "http://coquille/vm/runtime-worker.mjs?use-scheduling-api";
const URL_SANS_MARQUEUR = "http://coquille/vm/runtime-worker.mjs";
const SCHEDULER = { postTask: () => Promise.resolve() };

const wasmAdmis = () => Promise.resolve({});
const wasmRefuse = () =>
  Promise.reject(
    Object.assign(new Error("Wasm code generation disallowed"), { name: "CompileError" }),
  );

/** Environnement complet, dont chaque épreuve ne change que ce qu'elle mesure. */
function environnement(surcharges = {}) {
  return {
    href: URL_AVEC_MARQUEUR,
    scheduler: SCHEDULER,
    instancierWasm: wasmAdmis,
    sonderWorkerBlob: () => Promise.resolve("vivant"),
    ...surcharges,
  };
}

test("le chemin d'ordonnancement suit les deux conditions de v86, pas une seule", () => {
  assert.equal(
    cheminOrdonnancement({ href: URL_AVEC_MARQUEUR, scheduler: SCHEDULER }),
    CHEMINS_ORDONNANCEMENT.postTask,
  );
  // Marqueur présent mais moteur sans l'API : c'est le cas de WebKit, mesuré en #41.
  assert.equal(
    cheminOrdonnancement({ href: URL_AVEC_MARQUEUR, scheduler: null }),
    CHEMINS_ORDONNANCEMENT.workerBlob,
  );
  // API présente mais marqueur absent : c'est le cas d'un Worker chargé sans le paramètre.
  assert.equal(
    cheminOrdonnancement({ href: URL_SANS_MARQUEUR, scheduler: SCHEDULER }),
    CHEMINS_ORDONNANCEMENT.workerBlob,
  );
});

test("le contexte nominal ne produit aucune erreur et ne sonde aucun Worker", async () => {
  let sondes = 0;
  const erreur = await controlerRuntime(
    environnement({
      sonderWorkerBlob: () => {
        sondes += 1;
        return Promise.resolve("vivant");
      },
    }),
  );

  assert.equal(erreur, null);
  // La sonde coûte un délai : elle ne doit pas s'exécuter quand v86 ne prendra pas ce chemin.
  assert.equal(sondes, 0);
});

test("WebAssembly refusé est nommé, et rien d'autre n'est mesuré ensuite", async () => {
  let sondes = 0;
  const erreur = await controlerRuntime(
    environnement({
      instancierWasm: wasmRefuse,
      href: URL_SANS_MARQUEUR,
      sonderWorkerBlob: () => {
        sondes += 1;
        return Promise.resolve("aucun message reçu");
      },
    }),
  );

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.wasmRefused));
  assert.match(erreur.message, /wasm-unsafe-eval/);
  assert.equal(sondes, 0);
});

test("marqueur absent et Worker blob muet : le refus du Worker est nommé, avec sa raison", async () => {
  const erreur = await controlerRuntime(
    environnement({
      href: URL_SANS_MARQUEUR,
      sonderWorkerBlob: () => Promise.resolve("aucun message reçu"),
    }),
  );

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.workerRefused));
  assert.match(erreur.context.raison, /use-scheduling-api/);
  assert.equal(erreur.context.observation, "aucun message reçu");
});

test("scheduler.postTask absent : la raison distingue le moteur du paramètre d'URL", async () => {
  const erreur = await controlerRuntime(
    environnement({
      scheduler: null,
      sonderWorkerBlob: () => Promise.resolve("aucun message reçu"),
    }),
  );

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.workerRefused));
  assert.match(erreur.context.raison, /scheduler\.postTask/);
});

test("un Worker blob VIVANT ne produit aucune erreur : le diagnostic ne devine pas la politique", async () => {
  // Sous une CSP qui admet `blob:` dans `worker-src`, la boucle de secours de v86 fonctionne. Le
  // contrôle doit le CONSTATER plutôt que de l'affirmer d'avance, sans quoi son message serait faux
  // dès que la politique servie changerait.
  const erreur = await controlerRuntime(
    environnement({ href: URL_SANS_MARQUEUR, sonderWorkerBlob: () => Promise.resolve("vivant") }),
  );

  assert.equal(erreur, null);
});

test("sans constructeur Worker, aucune boucle n'est disponible et le code le dit", async () => {
  const erreur = await controlerRuntime(
    environnement({ scheduler: null, workerDisponible: false }),
  );

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.schedulingUnavailable));
});

test("une erreur de runtime refuse un code inconnu et traverse un port sans perdre son contexte", () => {
  assert.throws(() => new RuntimeError("VAULT_RUNTIME_INVENTE", "peu importe"), /inconnu/);

  const erreur = new RuntimeError(RUNTIME_ERROR_CODES.noTick, "message", { ticks: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(erreur)), {
    name: "RuntimeError",
    code: "VAULT_RUNTIME_NO_TICK",
    message: "message",
    context: { ticks: 1 },
  });
});

test("le chien de garde du premier tour rejette quand le compteur ne bouge pas", async () => {
  const garde = surveillerPremierTour(() => 1, { delaiMs: 150, periodeMs: 20 });
  const erreur = await garde.promesse.catch((echec) => echec);
  garde.arreter();

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.equal(erreur.context.ticks, 1);
});

test("le chien de garde se tait quand le compteur avance, et s'arrête sans rien laisser courir", async () => {
  let tours = 0;
  const garde = surveillerPremierTour(
    () => {
      tours += 7;
      return tours;
    },
    { delaiMs: 150, periodeMs: 20 },
  );
  const verdict = await Promise.race([
    garde.promesse.then(
      () => "resolue",
      () => "rejetee",
    ),
    new Promise((resolve) => setTimeout(() => resolve("silencieuse"), 300)),
  ]);
  garde.arreter();

  assert.equal(verdict, "silencieuse");
});

test("un compteur illisible n'est pas confondu avec un compteur figé", async () => {
  // Une montée de v86 qui renommerait `tick_counter` rendrait `null`. Le chien de garde doit alors
  // dire « illisible » et non « zéro tour » : la nuance change le diagnostic de l'exploitant.
  const garde = surveillerPremierTour(() => null, { delaiMs: 150, periodeMs: 20 });
  const erreur = await garde.promesse.catch((echec) => echec);
  garde.arreter();

  assert.equal(erreur.context.ticks, null);
  assert.match(erreur.message, /illisible/);
});
