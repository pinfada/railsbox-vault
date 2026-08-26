// Boucle d'ordonnancement fournie par Vault (#74, ADR 0013 option 3′). Ce que ces épreuves fixent :
// la boucle est posée à la place de celle du moteur, elle est OBSERVABLE, et elle refuse de mentir
// — ni pose silencieusement ratée, ni pose dans un contexte de page.
//
// Elles s'exécutent sous Node parce que la boucle reçoit sa cible en paramètre : `MessageChannel` et
// `setTimeout` sont pris SUR cette cible, jamais sur le global du module. Un faux global suffit donc
// à mesurer par quel chemin une tâche est passée, sans navigateur ni CSP.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCES_BOUCLE,
  cadencer,
  decrireBoucle,
  installerBoucleOrdonnancement,
} from "../../src/vm/scheduling-loop.mjs";

/**
 * Boucle de simulation : elle expose le point d'abonnement `auBattement` du descripteur réel, et
 * laisse l'épreuve décider QUAND la boucle bat. C'est ce qui permet de reproduire sous Node la
 * famine mesurée sous WebKit — la boucle tourne, les minuteries ne s'exécutent pas.
 */
function boucleDeSimulation() {
  const abonnes = new Set();
  return {
    source: SOURCES_BOUCLE.vault,
    auBattement(rappel) {
      abonnes.add(rappel);
      return () => abonnes.delete(rappel);
    },
    battre() {
      for (const rappel of [...abonnes]) rappel();
    },
    abonnes: () => abonnes.size,
  };
}

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

test("le chemin « setTimeout » est COMPTÉ, et son imbrication mesurée", async () => {
  // L'en-tête du module affirmait un risque — au-delà de cinq imbrications, `setTimeout` est borné à
  // quatre millisecondes — que rien ne mesurait (#87-1). Ces deux compteurs le rendent observable
  // dans un compte rendu de Worker, au lieu d'être supposé d'après le seul compteur de tours.
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });

  assert.deepEqual(boucle.minuteries(), { appels: 0, imbricationMax: 0 });

  // Un délai nul n'emprunte pas ce chemin, et ne doit donc pas le compter.
  await cible.scheduler.postTask(() => null, { delay: 0 });
  assert.deepEqual(boucle.minuteries(), { appels: 0, imbricationMax: 0 });

  // Trois minuteries en CHAÎNE : chacune est armée depuis le rappel de la précédente, ce qui est
  // exactement ce que la plateforme compte comme imbrication.
  const chainer = (reste) =>
    cible.scheduler.postTask(() => (reste > 1 ? chainer(reste - 1) : null), { delay: 1 });
  await chainer(3);

  assert.deepEqual(boucle.minuteries(), { appels: 3, imbricationMax: 3 });
  boucle.retirer();
});

test("une minuterie armée depuis le CANAL repart de zéro : le canal n'est pas une minuterie", async () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });

  await cible.scheduler.postTask(() => cible.scheduler.postTask(() => null, { delay: 1 }));
  await cible.scheduler.postTask(() => cible.scheduler.postTask(() => null, { delay: 1 }));

  assert.deepEqual(boucle.minuteries(), { appels: 2, imbricationMax: 1 });
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

test("« retirer » REFUSE de retirer une boucle qui n'est plus la nôtre", () => {
  // Un tiers qui pose son ordonnanceur par-dessus le nôtre ne doit pas se le faire retirer en
  // silence : notre retrait réaffecterait le natif — ou supprimerait la propriété — et emporterait
  // son travail. Le retrait est donc conditionné à l'IDENTITÉ de ce qui est en place (#87).
  const natif = faireNatif();
  const cible = faireCible({ natif });
  const boucle = installerBoucleOrdonnancement({ cible });
  const posee = cible.scheduler;
  const etranger = { postTask: () => Promise.resolve("étranger") };
  cible.scheduler = etranger;

  assert.throws(() => boucle.retirer(), /n'est plus celle de Vault/);
  assert.equal(cible.scheduler, etranger, "l'ordonnanceur du tiers est intact");
  // Le refus n'a rien consommé : le tiers retiré, le retrait redevient possible.
  cible.scheduler = posee;
  boucle.retirer();
  assert.equal(cible.scheduler, natif);
});

test("« retirer » refuse aussi quand la propriété a été supprimée sous la boucle", () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });
  const posee = cible.scheduler;
  delete cible.scheduler;

  assert.throws(() => boucle.retirer(), /n'est plus celle de Vault/);

  cible.scheduler = posee;
  boucle.retirer();
  assert.equal(cible.scheduler, undefined);
});

test("le repli « defineProperty » pose un « scheduler » NON énumérable, comme le natif", async () => {
  // `globalThis.scheduler` n'est énumérable dans aucun des moteurs mesurés. L'écart est sans effet
  // connu, mais du code qui énumère le global verrait apparaître une propriété que la plateforme ne
  // lui montre pas — et il est gratuit de ne pas la lui montrer (#87).
  const cible = faireCible();
  // Affectation sans effet : c'est ce qui force le repli sur `defineProperty`.
  Object.defineProperty(cible, "scheduler", {
    get: () => undefined,
    set: () => {},
    configurable: true,
  });

  const boucle = installerBoucleOrdonnancement({ cible });

  const descripteur = Object.getOwnPropertyDescriptor(cible, "scheduler");
  assert.equal(descripteur.enumerable, false);
  assert.equal(Object.keys(cible).includes("scheduler"), false);
  assert.equal(await cible.scheduler.postTask(() => "posée"), "posée");
  boucle.retirer();
});

test("une boucle RETIRÉE n'est plus décrite comme en place", async () => {
  // Le harnais de mesure de #74 boote l'image de référence avec la boucle du MOTEUR, en retirant la
  // nôtre avant que v86 ne l'emprunte. Si le descripteur continuait de se décrire, le compte rendu
  // annoncerait une boucle de Vault sur un boot qui n'en avait pas : la mesure « avant » et la
  // mesure « après » deviendraient indiscernables dans les rapports.
  const natif = faireNatif();
  const cible = faireCible({ natif });
  const boucle = installerBoucleOrdonnancement({ cible });

  await cible.scheduler.postTask(() => null);
  assert.deepEqual(decrireBoucle(boucle), {
    source: SOURCES_BOUCLE.vaultSurNative,
    natifPresent: true,
    appels: 1,
    minuteries: { appels: 0, imbricationMax: 0 },
    incidents: [],
  });

  boucle.retirer();

  assert.equal(decrireBoucle(boucle), null);
  assert.equal(cible.scheduler, natif);
  // Un second retrait ne doit rien casser : le harnais peut le demander sans savoir s'il a eu lieu.
  boucle.retirer();
  assert.equal(cible.scheduler, natif);
});

test("la cadence avance par la BOUCLE quand les minuteries sont affamées", () => {
  // Fait mesuré le 2026-08-26 dans un Worker de la coquille : sous WebKit, une boucle serrée de
  // messages de canal empêche `setInterval` et `setTimeout` de s'exécuter. Une échéance posée sur
  // une minuterie seule n'expirerait donc jamais pendant la fenêtre qu'elle borne — la plage où v86
  // tourne à plein. La cadence doit donc avancer aussi depuis la boucle elle-même.
  const boucle = boucleDeSimulation();
  let maintenant = 0;
  let appels = 0;
  const arreter = cadencer(() => (appels += 1), {
    periodeMs: 100,
    boucle,
    horloge: () => maintenant,
    // Minuteries affamées : `planifier` ne rappellera jamais. C'est WebKit sous boucle serrée.
    planifier: () => null,
    annuler: () => {},
  });

  boucle.battre();
  assert.equal(appels, 0, "un battement avant la période ne déclenche rien");
  maintenant = 150;
  boucle.battre();
  assert.equal(appels, 1);
  boucle.battre();
  assert.equal(appels, 1, "la cadence est bridée : un seul rappel par période");
  maintenant = 260;
  boucle.battre();
  assert.equal(appels, 2);

  arreter();
  maintenant = 500;
  boucle.battre();
  assert.equal(appels, 2, "arrêter désabonne la boucle");
  assert.equal(boucle.abonnes(), 0);
});

test("la cadence avance aussi par la minuterie, sans boucle posée", () => {
  let maintenant = 0;
  let appels = 0;
  let tic = null;
  const arreter = cadencer(() => (appels += 1), {
    periodeMs: 50,
    horloge: () => maintenant,
    planifier: (rappel) => {
      tic = rappel;
      return "minuterie";
    },
    annuler: (identifiant) => {
      assert.equal(identifiant, "minuterie");
      tic = null;
    },
  });

  maintenant = 60;
  tic();
  assert.equal(appels, 1);
  arreter();
  assert.equal(tic, null, "arrêter annule la minuterie");
});

test("les deux sources partagent le même bridage : la cadence ne double pas", () => {
  const boucle = boucleDeSimulation();
  let maintenant = 0;
  let appels = 0;
  let tic = null;
  cadencer(() => (appels += 1), {
    periodeMs: 100,
    boucle,
    horloge: () => maintenant,
    planifier: (rappel) => {
      tic = rappel;
      return 1;
    },
    annuler: () => {},
  });

  maintenant = 120;
  boucle.battre();
  tic();
  assert.equal(appels, 1, "battement et minuterie dans la même période ne comptent qu'une fois");
});

test("une boucle sans point d'abonnement ne fait pas échouer la cadence", () => {
  // C'est le descripteur rendu quand rien n'a été posé (mode « si le natif est absent ») : la
  // cadence doit alors retomber sur la minuterie seule, sans lever.
  let maintenant = 0;
  let appels = 0;
  let tic = null;
  cadencer(() => (appels += 1), {
    periodeMs: 10,
    boucle: { source: "native" },
    horloge: () => maintenant,
    planifier: (rappel) => {
      tic = rappel;
      return 1;
    },
    annuler: () => {},
  });
  maintenant = 100;
  tic();
  assert.equal(appels, 1);
});

test("la boucle posée expose ses battements, un par tâche exécutée", async () => {
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });
  let battements = 0;
  const desabonner = boucle.auBattement(() => (battements += 1));

  await cible.scheduler.postTask(() => null);
  await cible.scheduler.postTask(() => null);
  assert.equal(battements, 2);

  desabonner();
  await cible.scheduler.postTask(() => null);
  assert.equal(battements, 2, "se désabonner arrête les battements");
  boucle.retirer();
});

test("un abonné fautif n'emporte pas la boucle, et sa faute est consignée", async () => {
  // Un rappel qui lève ne doit pas arrêter l'émulateur — mais il ne doit pas disparaître non plus.
  // Sa faute est consignée et publiée par le compte rendu ; le tour suivant a lieu quand même.
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });
  boucle.auBattement(() => {
    throw new Error("abonné fautif");
  });

  assert.equal(await cible.scheduler.postTask(() => "premier"), "premier");
  assert.equal(await cible.scheduler.postTask(() => "second"), "second");
  assert.deepEqual(decrireBoucle(boucle).incidents, ["abonné fautif", "abonné fautif"]);
  boucle.retirer();
});

test("une tâche dont le signal est déjà abandonné est refusée, pas exécutée en silence", async () => {
  // `postTask` de la plateforme accepte `signal` et `priority` ; la boucle de Vault n'implémente
  // NI l'un NI l'autre — v86 n'en passe aucun. Ignorer un signal DÉJÀ abandonné exécuterait une
  // tâche que l'appelant a annulée : le seul cas décidable sans machinerie est donc refusé net.
  const cible = faireCible();
  const boucle = installerBoucleOrdonnancement({ cible });
  const controle = new AbortController();
  controle.abort();
  let executee = false;

  await assert.rejects(
    cible.scheduler.postTask(() => (executee = true), { signal: controle.signal }),
    (erreur) => erreur.name === "AbortError",
  );
  assert.equal(executee, false);
  boucle.retirer();
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
