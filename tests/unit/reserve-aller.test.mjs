/**
 * `aller()` des épreuves navigateur de la réserve (#299) : la tolérance au rechargement de première visite de
 * Firefox est BORNÉE (moteur, première visite, URL exacte, état et URL finals), et une navigation inattendue
 * fait ÉCHOUER l'épreuve. Ces épreuves sont le témoin de mordant de la tolérance.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { aller } from "../browser/support-reserve.mjs";

const URL_ATTENDUE = "http://127.0.0.1:4195/index.html";
const interrompue = (cible = URL_ATTENDUE) =>
  new Error(
    `page.goto: Navigation to "${URL_ATTENDUE}" is interrupted by another navigation to "${cible}"`,
  );

/** Une page factice : `goto` jette `erreur` (ou réussit), `url()` rend l'URL finale, `etat` la coquille. */
function fausse({
  moteur = "firefox",
  erreur = null,
  url = URL_ATTENDUE,
  etat = "prete",
  contexte = {},
} = {}) {
  return {
    moteur,
    context: () => contexte,
    goto: async () => {
      if (erreur) throw erreur;
    },
    url: () => url,
    evaluate: async () => ({
      coquille: etat,
      rapport: null,
      bandeau: null,
      refus: null,
      workers: 0,
    }),
  };
}

test("Firefox, première visite, message exact, URL et état finals attendus : tolérée", async () => {
  await aller(fausse({ erreur: interrompue() }), URL_ATTENDUE, { delaiMs: 300 });
});

test("sans erreur : rien à tolérer, et la visite est mémorisée", async () => {
  await aller(fausse(), URL_ATTENDUE, { delaiMs: 300 });
});

test("MORDANT — un autre moteur : la même erreur est RELEVÉE", async () => {
  for (const moteur of ["chromium", "webkit", null]) {
    await assert.rejects(
      aller(fausse({ moteur, erreur: interrompue() }), URL_ATTENDUE, { delaiMs: 300 }),
      /interrupted by another navigation/,
      String(moteur),
    );
  }
});

test("MORDANT — pas une première visite : la même erreur est RELEVÉE", async () => {
  const contexte = {};
  await aller(fausse({ contexte }), URL_ATTENDUE, { delaiMs: 300 });
  await assert.rejects(
    aller(fausse({ contexte, erreur: interrompue() }), URL_ATTENDUE, { delaiMs: 300 }),
    /interrupted by another navigation/,
  );
});

test("MORDANT — une navigation vers une AUTRE URL est RELEVÉE, même sous Firefox à la première visite", async () => {
  await assert.rejects(
    aller(fausse({ erreur: interrompue("http://127.0.0.1:4195/autre.html") }), URL_ATTENDUE, {
      delaiMs: 300,
    }),
    /interrupted by another navigation/,
  );
});

test("MORDANT — toute autre erreur est RELEVÉE", async () => {
  for (const erreur of [
    new Error("net::ERR_CONNECTION_REFUSED"),
    new Error("Timeout 30000ms exceeded"),
  ]) {
    await assert.rejects(aller(fausse({ erreur }), URL_ATTENDUE, { delaiMs: 300 }), erreur);
  }
});

test("MORDANT — tolérée, mais l'URL finale n'est pas l'URL attendue : l'épreuve ÉCHOUE", async () => {
  await assert.rejects(
    aller(
      fausse({ erreur: interrompue(), url: "http://127.0.0.1:4195/ailleurs.html" }),
      URL_ATTENDUE,
      { delaiMs: 300 },
    ),
    /l'URL est/,
  );
});

test("MORDANT — tolérée, mais la coquille n'atteint aucun état final : l'épreuve ÉCHOUE", async () => {
  await assert.rejects(
    aller(fausse({ erreur: interrompue(), etat: "demarrage" }), URL_ATTENDUE, { delaiMs: 300 }),
    /état final/,
  );
});

test("MORDANT — le témoin positif de la sonde des Workers JETTE quand la sonde ne compte pas", async () => {
  const { verifierLaSonde } = await import("../browser/support-reserve.mjs");
  const contexteSans = (resultat) => ({
    newPage: async () => ({
      goto: async () => {},
      evaluate: async () => resultat,
      close: async () => {},
    }),
  });
  await assert.rejects(verifierLaSonde(contexteSans([undefined, undefined])), /ne compte pas/);
  await assert.rejects(verifierLaSonde(contexteSans([0, 0])), /ne compte pas/);
  await verifierLaSonde(contexteSans([0, 1]));
});
