import assert from "node:assert/strict";
import test from "node:test";

import {
  ANNOTATION_RECUPERATION_FIREFOX,
  instrumenterNavigationFirefox,
} from "../support/navigation-firefox.mjs";

function pageFactice({ goto, url = "http://127.0.0.1:4173/avant", etat } = {}) {
  return {
    goto,
    url: () => url,
    evaluate: async () => etat ?? { url, pret: "complete" },
  };
}

test("une navigation Firefox saine n'est jamais rejouée", async () => {
  const appels = [];
  const reponse = { status: 200 };
  const page = pageFactice({
    goto: async (...argumentsRecus) => {
      appels.push(argumentsRecus);
      return reponse;
    },
  });

  instrumenterNavigationFirefox(page, {
    browserName: "firefox",
    baseURL: "http://127.0.0.1:4173",
    attendre: async () => {},
  });

  assert.equal(await page.goto("/index.html"), reponse);
  assert.equal(appels.length, 1);
});

test("les autres moteurs ne sont pas instrumentés", async () => {
  const goto = async () => "réponse";
  const page = pageFactice({ goto });

  const instrumentee = instrumenterNavigationFirefox(page, { browserName: "chromium" });

  assert.equal(instrumentee, false);
  assert.equal(page.goto, goto);
});

test("la signature exacte page complète + goto bloqué déclenche une navigation identique annotée", async () => {
  const appels = [];
  const annotations = [];
  const journaux = [];
  const reponseRecuperee = { status: 200, reprise: true };
  const page = pageFactice({
    goto: async (...argumentsRecus) => {
      appels.push(argumentsRecus);
      if (appels.length === 1) return new Promise(() => {});
      return reponseRecuperee;
    },
    etat: { url: "http://127.0.0.1:4173/index.html", pret: "complete" },
  });

  instrumenterNavigationFirefox(page, {
    browserName: "firefox",
    baseURL: "http://127.0.0.1:4173",
    attendre: async () => {},
    annoter: (annotation) => annotations.push(annotation),
    journaliser: (message) => journaux.push(message),
  });

  assert.equal(await page.goto("/index.html", { waitUntil: "commit" }), reponseRecuperee);
  assert.deepEqual(appels, [
    ["/index.html", { waitUntil: "commit" }],
    ["/index.html", { waitUntil: "commit" }],
  ]);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].type, ANNOTATION_RECUPERATION_FIREFOX);
  assert.match(annotations[0].description, /index\.html/);
  assert.match(journaux[0], /Firefox navigation récupérée/);
});

test("une URL différente n'est pas prise pour le blocage mesuré", async () => {
  let resoudre;
  let appels = 0;
  const premiere = new Promise((resolve) => {
    resoudre = resolve;
  });
  const page = pageFactice({
    goto: async () => {
      appels += 1;
      return premiere;
    },
    etat: { url: "http://127.0.0.1:4173/redirection", pret: "complete" },
  });

  instrumenterNavigationFirefox(page, {
    browserName: "firefox",
    baseURL: "http://127.0.0.1:4173",
    attendre: async () => {},
  });

  const navigation = page.goto("/index.html");
  await Promise.resolve();
  resoudre("originale");
  assert.equal(await navigation, "originale");
  assert.equal(appels, 1);
});

test("un document encore en chargement n'est pas pris pour le blocage mesuré", async () => {
  let resoudre;
  let appels = 0;
  const premiere = new Promise((resolve) => {
    resoudre = resolve;
  });
  const page = pageFactice({
    goto: async () => {
      appels += 1;
      return premiere;
    },
    etat: { url: "http://127.0.0.1:4173/index.html", pret: "interactive" },
  });

  instrumenterNavigationFirefox(page, {
    browserName: "firefox",
    baseURL: "http://127.0.0.1:4173",
    attendre: async () => {},
  });

  const navigation = page.goto("/index.html");
  await Promise.resolve();
  resoudre("originale");
  assert.equal(await navigation, "originale");
  assert.equal(appels, 1);
});
