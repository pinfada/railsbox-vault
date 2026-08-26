// Diagnostic typé du runtime (#52). Ce que ces épreuves fixent : un contexte qui ne peut pas faire
// battre v86 produit un CODE, et ce code désigne la cause exacte — jamais une cause voisine, jamais
// un silence. Elles s'exécutent sous Node parce que le contrôle préalable reçoit son environnement
// en paramètre : la CSP n'a pas besoin d'être reproduite pour éprouver la décision qu'elle provoque.

import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_ERROR_CODES, RuntimeError, isRuntimeError } from "../../src/vm/runtime-errors.mjs";
import {
  executerSousGarde,
  mesurerRythme,
  surveillerPremierTour,
} from "../../src/vm/runtime-environment.mjs";
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

test("un compteur JAMAIS lisible ne fait pas échouer le boot : il est consigné", async () => {
  // Une montée de v86 qui renommerait `tick_counter` rendrait `null` à chaque lecture. Faire alors
  // échouer un émulateur SAIN au bout de vingt secondes serait pire que le silence que cette issue
  // combat : le chien de garde perdrait sa capacité d'observation et gagnerait un faux positif.
  // Il se tait donc, et consigne une observation TYPÉE non fatale.
  const garde = surveillerPremierTour(() => null, { delaiMs: 150, periodeMs: 20 });
  const verdict = await Promise.race([
    garde.promesse.then(
      () => "resolue",
      () => "rejetee",
    ),
    new Promise((resolve) => setTimeout(() => resolve("silencieuse"), 300)),
  ]);
  garde.arreter();

  assert.equal(verdict, "silencieuse");
  const observations = garde.observations();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].code, RUNTIME_ERROR_CODES.ticksUnreadable);
  assert.match(observations[0].message, /tick_counter/);
});

test("un compteur figé reste fatal, et son contexte porte un nombre, pas « illisible »", async () => {
  const garde = surveillerPremierTour(() => 3, { delaiMs: 150, periodeMs: 20 });
  const erreur = await garde.promesse.catch((echec) => echec);
  garde.arreter();

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.equal(erreur.context.ticks, 3);
  assert.doesNotMatch(erreur.message, /illisible/);
  assert.deepEqual(garde.observations(), []);
});

test("la garde couvre TOUTE la phase confiée, pas seulement sa première attente", async () => {
  // Défaut réel du chemin de l'image de référence : `boot()` y rend la main juste après
  // `emulator.run()`, AVANT l'invite. Une garde annulée à la fin de `boot()` n'aurait pas eu le
  // temps de prendre deux échantillons, et un émulateur qui ne bat pas serait retombé sur
  // `awaitHealth`, dont l'expiration accuse le GUEST — exactement le symptôme de #52.
  let secondePhaseTerminee = false;
  const travail = async () => {
    // Première phase, courte : l'équivalent de `boot()`.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Seconde phase, longue : l'équivalent de `awaitHealth()`.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    secondePhaseTerminee = true;
  };

  const debut = Date.now();
  const erreur = await executerSousGarde(() => 1, travail, {
    delaiMs: 150,
    periodeMs: 20,
  }).catch((echec) => echec);

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.ok(Date.now() - debut < 3000, "la garde doit trancher sans attendre la seconde phase");
  assert.equal(secondePhaseTerminee, false);
});

test("sous famine des minuteries, la garde expire quand même — par la boucle", async () => {
  // Le cas mesuré sous WebKit : la boucle d'ordonnancement tourne à plein, et AUCUNE minuterie de
  // ce Worker ne s'exécute. Une garde posée sur `setTimeout` n'expirerait donc jamais pendant la
  // plage qu'elle borne, et un émulateur qui ne bat pas retomberait sur le délai de garde du guest
  // — dont l'expiration accuse le GUEST. C'est le silence de #52 par une autre porte.
  //
  // Le délai est ici de cinq secondes de temps RÉEL : si la garde dépendait encore d'une minuterie,
  // rien n'expirerait dans la fenêtre de cette épreuve. Seul le battement de la boucle, lu sur une
  // horloge injectée, peut la faire trancher.
  let maintenant = 0;
  let battre = null;
  const garde = surveillerPremierTour(() => 1, {
    delaiMs: 5000,
    horloge: () => maintenant,
    cadence: (rappel) => {
      battre = rappel;
      return () => {
        battre = null;
      };
    },
  });

  maintenant = 1000;
  battre();
  maintenant = 6000;
  battre();
  const erreur = await Promise.race([
    garde.promesse.catch((echec) => echec),
    new Promise((resolve) => setTimeout(() => resolve("aucune expiration"), 300)),
  ]);
  garde.arreter();

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.equal(erreur.context.ticks, 1);
});

test("la garde reste silencieuse quand la boucle avance, même cadencée par elle", async () => {
  let maintenant = 0;
  let tours = 0;
  let battre = null;
  const garde = surveillerPremierTour(
    () => {
      tours += 3;
      return tours;
    },
    {
      delaiMs: 5000,
      horloge: () => maintenant,
      cadence: (rappel) => {
        battre = rappel;
        return () => {};
      },
    },
  );

  maintenant = 1000;
  battre();
  maintenant = 6000;
  battre();
  const verdict = await Promise.race([
    garde.promesse.then(
      () => "resolue",
      () => "rejetee",
    ),
    new Promise((resolve) => setTimeout(() => resolve("silencieuse"), 200)),
  ]);
  garde.arreter();

  assert.equal(verdict, "silencieuse");
});

test("compteur figé et boucle jamais empruntée : la garde nomme le marqueur d'URL", async () => {
  // Depuis #74, la boucle d'ordonnancement est POSÉE par Vault dans tout Worker runtime. Un
  // compteur figé n'a donc plus la même cause qu'avant : ou bien v86 n'emprunte pas notre boucle —
  // et il ne reste qu'une raison, le marqueur d'URL —, ou bien il l'emprunte et la panne est
  // ailleurs. Le compteur d'appels de la boucle est ce qui sépare les deux ; sans lui, le message
  // devrait deviner.
  const garde = surveillerPremierTour(() => 1, {
    delaiMs: 150,
    periodeMs: 20,
    decrireBoucle: () => ({ source: "vault-sur-native", natifPresent: true, appels: 0 }),
  });
  const erreur = await garde.promesse.catch((echec) => echec);
  garde.arreter();

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.deepEqual(erreur.context.boucle, {
    source: "vault-sur-native",
    natifPresent: true,
    appels: 0,
  });
  assert.match(erreur.message, /use-scheduling-api/);
});

test("compteur figé alors que la boucle a reçu des tâches : la panne est déclarée ailleurs", async () => {
  const garde = surveillerPremierTour(() => 4, {
    delaiMs: 150,
    periodeMs: 20,
    decrireBoucle: () => ({ source: "vault", natifPresent: false, appels: 12 }),
  });
  const erreur = await garde.promesse.catch((echec) => echec);
  garde.arreter();

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.equal(erreur.context.boucle.appels, 12);
  assert.doesNotMatch(erreur.message, /use-scheduling-api/);
  assert.match(erreur.message, /ailleurs/);
});

test("sans boucle décrite, le message de compteur figé reste celui d'avant #74", async () => {
  const garde = surveillerPremierTour(() => 1, { delaiMs: 150, periodeMs: 20 });
  const erreur = await garde.promesse.catch((echec) => echec);
  garde.arreter();

  assert.ok(isRuntimeError(erreur, RUNTIME_ERROR_CODES.noTick));
  assert.equal(erreur.context.boucle, null);
});

test("le rythme de la boucle est une mesure : un compteur illisible ne vaut pas zéro tour", () => {
  // Le rythme sert à COMPARER deux exécutions de l'émulateur — avec et sans la boucle posée par
  // Vault (#74). Il faut donc qu'un compteur absent se distingue d'un compteur à zéro : le premier
  // dit « instrument perdu », le second dirait « émulateur arrêté ».
  assert.deepEqual(mesurerRythme({ ticks: 2000, fenetreMs: 4000 }), {
    ticks: 2000,
    fenetreMs: 4000,
    ticksParSeconde: 500,
  });
  assert.deepEqual(mesurerRythme({ ticks: null, fenetreMs: 4000 }), {
    ticks: null,
    fenetreMs: 4000,
    ticksParSeconde: null,
  });
  // Une fenêtre nulle ou absente ne produit pas une division : elle produit une absence de mesure.
  assert.equal(mesurerRythme({ ticks: 10, fenetreMs: 0 }).ticksParSeconde, null);
  assert.equal(mesurerRythme({ ticks: 10, fenetreMs: null }).ticksParSeconde, null);
});

test("la garde rend la valeur de la phase et ses observations quand la boucle avance", async () => {
  let tours = 0;
  const observations = [];
  const valeur = await executerSousGarde(
    () => {
      tours += 5;
      return tours;
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "sante";
    },
    { delaiMs: 400, periodeMs: 20, onObservation: (o) => observations.push(o) },
  );

  assert.equal(valeur, "sante");
  assert.deepEqual(observations, []);
});
