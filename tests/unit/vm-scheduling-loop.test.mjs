// Boucle d'ordonnancement fournie par Vault (#74, ADR 0013 option 3′). Ce que ces épreuves fixent :
// la boucle est posée à la place de celle du moteur, elle est OBSERVABLE, et elle refuse de mentir
// — ni pose silencieusement ratée, ni pose dans un contexte de page.
//
// Elles s'exécutent sous Node parce que la boucle reçoit sa cible en paramètre : `MessageChannel` et
// `setTimeout` sont pris SUR cette cible, jamais sur le global du module. Un faux global suffit donc
// à mesurer par quel chemin une tâche est passée, sans navigateur ni CSP.

import assert from "node:assert/strict";
import test from "node:test";

import { SOURCES_BOUCLE, installerBoucleOrdonnancement } from "../../src/vm/scheduling-loop.mjs";

/** Faux contexte de Worker : les primitives réelles, plus un compteur d'appels à `setTimeout`. */
function faireCible({ natif = null } = {}) {
  const minuteries = [];
  const cible = {
    MessageChannel,
    setTimeout: (rappel, delai) => {
      minuteries.push(delai);
      return setTimeout(rappel, delai);
    },
    minuteries,
  };
  if (natif) cible.scheduler = natif;
  return cible;
}

/** Ordonnanceur natif de simulation : il note qu'il a été appelé, pour prouver qu'il ne l'est pas. */
function faireNatif() {
  const appels = [];
  return {
    appels,
    postTask: (rappel) => {
      appels.push("postTask");
      return Promise.resolve(rappel());
    },
    yield: () => Promise.resolve("natif"),
  };
}

test("la boucle est posée PAR-DESSUS l'implémentation native, et le natif n'est plus appelé", async () => {
  // C'est la décision de #74, et elle ne va pas de soi : Firefox EXPOSE `scheduler.postTask`, donc
  // « poser seulement si l'API manque » n'y changerait rien. La mesure de l'ADR 0013 dit que c'est
  // l'implémentation native qui monopolise le thread ; il faut donc la remplacer.
  const natif = faireNatif();
  const cible = faireCible({ natif });

  const boucle = installerBoucleOrdonnancement({ cible });

  assert.equal(boucle.source, SOURCES_BOUCLE.vaultSurNative);
  assert.equal(boucle.natifPresent, true);
  assert.notEqual(cible.scheduler.postTask, natif.postTask);
  assert.equal(await cible.scheduler.postTask(() => "fait"), "fait");
  assert.deepEqual(natif.appels, []);
  boucle.retirer();
});

test("« si le natif est absent » NE remplace PAS une API présente — le mode existe et ne suffit pas", async () => {
  const natif = faireNatif();
  const cible = faireCible({ natif });

  const boucle = installerBoucleOrdonnancement({ cible, siNatifAbsent: true });

  assert.equal(boucle.source, SOURCES_BOUCLE.native);
  assert.equal(cible.scheduler, natif);
  assert.equal(await cible.scheduler.postTask(() => "fait"), "fait");
  assert.deepEqual(natif.appels, ["postTask"]);
});

test("sans API native, la boucle est posée dans les deux modes", () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible, siNatifAbsent: true });
  assert.equal(boucle.source, SOURCES_BOUCLE.vault);
  assert.equal(boucle.natifPresent, false);
  assert.equal(typeof cible.scheduler.postTask, "function");
  boucle.retirer();
});

test("un délai nul passe par le canal de messages, jamais par une minuterie", async () => {
  // Au-delà de cinq imbrications, les moteurs bornent `setTimeout(…, 0)` à quatre millisecondes :
  // la boucle de v86 plafonnerait à 250 tours par seconde. Un message de canal n'est pas bridé.
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });

  await cible.scheduler.postTask(() => "immédiat");
  await cible.scheduler.postTask(() => "immédiat", { delay: 0 });

  assert.deepEqual(cible.minuteries, []);
  assert.equal(boucle.appels(), 2);
  boucle.retirer();
});

test("un délai non nul passe par la minuterie de la cible, avec ce délai", async () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });

  await cible.scheduler.postTask(() => "plus tard", { delay: 5 });

  assert.deepEqual(cible.minuteries, [5]);
  boucle.retirer();
});

test("les tâches à délai nul s'exécutent dans l'ordre où elles ont été confiées", async () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });
  const ordre = [];

  await Promise.all([1, 2, 3, 4].map((rang) => cible.scheduler.postTask(() => ordre.push(rang))));

  assert.deepEqual(ordre, [1, 2, 3, 4]);
  boucle.retirer();
});

test("une tâche qui lève rejette sa promesse au lieu d'arrêter la boucle", async () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });

  await assert.rejects(
    cible.scheduler.postTask(() => {
      throw new Error("tâche fautive");
    }),
    /tâche fautive/,
  );
  // La boucle reste vivante : une tâche fautive ne doit pas emporter l'émulateur avec elle.
  assert.equal(await cible.scheduler.postTask(() => "suivante"), "suivante");
  boucle.retirer();
});

test("le compteur d'appels distingue « boucle posée » de « boucle empruntée »", async () => {
  // Poser la boucle ne prouve pas que v86 l'emprunte : il arrête son chemin d'ordonnancement à
  // l'évaluation de son module, sur `location.href`. Le compteur est ce qui rend le fait observable
  // dans un compte rendu, au lieu d'être supposé.
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });

  assert.equal(boucle.appels(), 0);
  await cible.scheduler.postTask(() => null);
  assert.equal(boucle.appels(), 1);
  boucle.retirer();
});

test("la boucle refuse de se poser dans un contexte de PAGE", () => {
  // L'ADR 0013 la restreint aux Workers de Vault : remplacer l'ordonnanceur d'un document
  // changerait le rythme de code qui n'est pas le nôtre, pour un gain nul — v86 vit dans le Worker.
  const page = faireCible();
  page.document = {};

  assert.throws(() => installerBoucleOrdonnancement({ cible: page }), /Worker/);
  assert.equal(page.scheduler, undefined);
});

test("une pose refusée par le contexte lève, au lieu de rendre un succès qui n'en est pas un", () => {
  const cible = faireCible();
  const natif = faireNatif();
  Object.defineProperty(cible, "scheduler", {
    value: natif,
    writable: false,
    configurable: false,
  });

  // Sans ce contrôle, v86 emprunterait la boucle du moteur en silence — exactement la panne de #74,
  // avec en plus un compte rendu affirmant que la boucle de Vault était en place.
  assert.throws(() => installerBoucleOrdonnancement({ cible }), /scheduler/);
  assert.equal(cible.scheduler, natif);
});

test("une cible sans « MessageChannel » est refusée, et le dit", () => {
  const cible = { setTimeout };
  assert.throws(() => installerBoucleOrdonnancement({ cible }), /MessageChannel/);
});

test("une seconde pose sur la même cible ne réempile pas de boucle", async () => {
  const cible = faireCible();
  const premiere = installerBoucleOrdonnancement({ cible });
  const posee = cible.scheduler;

  const seconde = installerBoucleOrdonnancement({ cible });

  assert.equal(cible.scheduler, posee);
  assert.equal(seconde, premiere);
  await cible.scheduler.postTask(() => null);
  assert.equal(seconde.appels(), 1);
  premiere.retirer();
});

test("« retirer » rend le contexte à son état d'origine, natif compris", () => {
  const natif = faireNatif();
  const cible = faireCible({ natif });

  const boucle = installerBoucleOrdonnancement({ cible });
  boucle.retirer();

  assert.equal(cible.scheduler, natif);
  // Et une pose ultérieure redevient possible : le retrait n'a rien laissé derrière lui.
  const seconde = installerBoucleOrdonnancement({ cible });
  assert.equal(seconde.source, SOURCES_BOUCLE.vaultSurNative);
  seconde.retirer();
});

test("les autres membres de l'ordonnanceur natif restent atteignables", async () => {
  // La boucle remplace `postTask` et rien d'autre. Retirer `scheduler.yield` d'un moteur qui
  // l'expose priverait du code étranger à v86 d'une capacité, sans aucune raison mesurée.
  const natif = faireNatif();
  const cible = faireCible({ natif });
  const boucle = installerBoucleOrdonnancement({ cible });

  assert.equal(await cible.scheduler.yield(), "natif");
  boucle.retirer();
});
