/**
 * La GARDE FERMÉE du Service Worker de la coquille (#299, ADR 0048 § 4) : toute requête d'un client
 * contrôlé est REFUSÉE, sauf la liste épinglée et deux passages de DONNÉES. Rien ne part à l'origine
 * « parce qu'elle n'est pas listée ».
 *
 * Gardes éprouvées : 11 (`/artifacts/**` n'est pas servi par le SW), 12 (passage : destination, chemin,
 * redirection, type), 13 (« hors liste → réseau »), 14 (« hors origine → réseau »), 17 (méthode).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PREFIXE_ADRESSES_V86 } from "../../src/v86-adresses.mjs";
import { FICHIERS, ORIGINE, installe } from "./support-sw-reserve.mjs";

const DESTINATIONS_EXECUTABLES = [
  "script",
  "worker",
  "sharedworker",
  "serviceworker",
  "audioworklet",
  "paintworklet",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "manifest",
  "xslt",
];

const refus = (resultat) => resultat.reponse.headers.get("X-Vault-Refus");

test("une requête HORS LISTE est refusée (503, X-Vault-Refus) et ne part JAMAIS au réseau (garde 13)", async () => {
  const sw = await installe(
    FICHIERS,
    {},
    { "/pas-epingle.mjs": { corps: "export const PIRE = 1;\n" } },
  );
  sw.appels.length = 0;
  for (const destination of ["", "script", "worker", "document", "style", "image"]) {
    const resultat = await sw.requete("/pas-epingle.mjs", { destination });
    assert.equal(resultat.repondu, true, `${destination} : le SW répond, il ne laisse pas passer`);
    assert.equal(resultat.reponse.status, 503, destination);
    assert.equal(refus(resultat), "HORS_LISTE", destination);
  }
  assert.deepEqual(
    sw.appels,
    [],
    "aucune requête réseau pour un fichier que la liste n'épingle pas",
  );
});

test("une requête HORS ORIGINE est refusée et ne part pas au réseau, y compris vers l'origine applicative (garde 14)", async () => {
  const sw = await installe(FICHIERS);
  sw.appels.length = 0;
  for (const origine of [
    "http://localhost:4180",
    "https://autre.exemple",
    "http://127.0.0.1:4179",
  ]) {
    const resultat = await sw.requete("/document-applicatif.html", {
      origine,
      destination: "iframe",
    });
    assert.equal(resultat.repondu, true, origine);
    assert.equal(resultat.reponse.status, 503, origine);
    assert.equal(refus(resultat), "HORS_ORIGINE", origine);
  }
  assert.deepEqual(sw.appels, []);
});

test("toute méthode autre que GET sur une entrée listée est refusée", async () => {
  const sw = await installe(FICHIERS);
  sw.appels.length = 0;
  for (const methode of ["POST", "PUT", "DELETE", "PATCH"]) {
    const resultat = await sw.requete("/main.mjs", { methode });
    assert.equal(resultat.reponse.status, 503, methode);
  }
  assert.deepEqual(sw.appels, []);
});

test("`/artifacts/**` n'est jamais SERVI par le SW : la requête de données part au réseau, tel quel (garde 11)", async () => {
  const sw = await installe(
    FICHIERS,
    {},
    {
      "/artifacts/application.json": {
        corps: '{"ok":true}',
        entetes: { "Content-Type": "application/json" },
      },
    },
  );
  sw.appels.length = 0;
  const resultat = await sw.requete("/artifacts/application.json", { destination: "" });
  assert.equal(resultat.reponse.status, 200);
  assert.equal(await resultat.reponse.text(), '{"ok":true}');
  assert.equal(sw.appels.length, 1, "la réponse vient du réseau, jamais d'une copie de la réserve");
  assert.equal(sw.appels[0].chemin, "/artifacts/application.json");
  assert.equal(sw.appels[0].redirect, "manual", "la redirection n'est jamais suivie");
});

test("le passage refuse TOUTE destination exécutable, sans aller au réseau (garde 12)", async () => {
  const sw = await installe(FICHIERS, {}, { "/artifacts/application.json": { corps: "{}" } });
  sw.appels.length = 0;
  for (const destination of DESTINATIONS_EXECUTABLES) {
    const resultat = await sw.requete("/artifacts/application.json", { destination });
    assert.equal(resultat.reponse.status, 503, destination);
    assert.equal(refus(resultat), "PASSAGE_DESTINATION_EXECUTABLE", destination);
  }
  assert.deepEqual(sw.appels, [], "une destination exécutable n'atteint pas l'origine");
});

test("le passage refuse un chemin qui contient %2e, %2f, %5c ou %00 (garde 12)", async () => {
  const sw = await installe(FICHIERS, {}, { "/artifacts/ok.json": { corps: "{}" } });
  sw.appels.length = 0;
  for (const chemin of [
    "/artifacts/a%2eb",
    "/artifacts/a%2Eb",
    "/artifacts/a%2fb",
    "/artifacts/a%2Fb",
    "/artifacts/a%5cb",
    "/artifacts/a%5Cb",
    "/artifacts/a%00b",
  ]) {
    const resultat = await sw.requete(chemin, { destination: "" });
    assert.equal(resultat.reponse.status, 503, chemin);
    assert.equal(refus(resultat), "PASSAGE_CHEMIN_SUSPECT", chemin);
  }
  assert.deepEqual(sw.appels, []);
});

test("un antislash est NORMALISÉ en `/` par l'URL elle-même : `pathname` n'en porte jamais, la garde n'a donc rien à y lire (preuve d'équivalence, ADR 0048 amendé)", () => {
  assert.equal(new URL("https://coquille.test/artifacts/a\\b").pathname, "/artifacts/a/b");
  assert.equal(
    new URL("https://coquille.test/artifacts/a%5cb").pathname,
    "/artifacts/a%5cb",
    "%5c, lui, n'est pas décodé : c'est lui que la garde lit",
  );
});

test("`%2e%2e` est normalisé par l'URL elle-même : la requête sort de `/artifacts/` et tombe dans la garde fermée", async () => {
  const sw = await installe(FICHIERS, {}, { "/secret": { corps: "x" } });
  sw.appels.length = 0;
  const resultat = await sw.requete("/artifacts/%2e%2e/secret", { destination: "" });
  assert.equal(resultat.reponse.status, 503);
  assert.deepEqual(sw.appels, []);
});

test("une REDIRECTION du passage n'est jamais suivie ni rendue (garde 12)", async () => {
  const sw = await installe(
    FICHIERS,
    {},
    {
      "/artifacts/r.json": { statut: 302, redirection: "https://autre.exemple/x" },
    },
  );
  const resultat = await sw.requete("/artifacts/r.json", { destination: "" });
  assert.equal(resultat.reponse.status, 503);
  assert.equal(refus(resultat), "PASSAGE_REDIRECTION");
  assert.equal(sw.appels.at(-1).redirect, "manual");
});

test("une réponse de type script, wasm, HTML, XML ou CSS sous `/artifacts/` est refusée (garde 12)", async () => {
  const types = [
    "text/javascript",
    "application/javascript",
    "application/wasm",
    "text/html",
    "application/xhtml+xml",
    "text/xml",
    "application/xml",
    "text/css",
  ];
  const reseau = {};
  for (const [i, type] of types.entries())
    reseau[`/artifacts/t${i}`] = { corps: "x", entetes: { "Content-Type": type } };
  const sw = await installe(FICHIERS, {}, reseau);
  for (const [i, type] of types.entries()) {
    const resultat = await sw.requete(`/artifacts/t${i}`, { destination: "" });
    assert.equal(resultat.reponse.status, 503, type);
    assert.equal(refus(resultat), "PASSAGE_TYPE_EXECUTABLE", type);
  }
  const bien = await installe(
    FICHIERS,
    {},
    {
      "/artifacts/ok.bin": { corps: "x", entetes: { "Content-Type": "application/octet-stream" } },
    },
  );
  assert.equal((await bien.requete("/artifacts/ok.bin", { destination: "" })).reponse.status, 200);
});

test("le PASSAGE NOMMÉ de `v86.wasm` admet application/wasm en `fetch` de données, et refuse une destination exécutable", async () => {
  const wasm = `${PREFIXE_ADRESSES_V86}v86-0123456789abcdef.wasm`;
  const sw = await installe(
    FICHIERS,
    {},
    { [wasm]: { corps: "\0asm", entetes: { "Content-Type": "application/wasm" } } },
  );
  assert.equal((await sw.requete(wasm, { destination: "" })).reponse.status, 200);
  const exec = await sw.requete(wasm, { destination: "worker" });
  assert.equal(exec.reponse.status, 503);
  assert.equal(refus(exec), "PASSAGE_DESTINATION_EXECUTABLE");
  const html = await installe(
    FICHIERS,
    {},
    { [wasm]: { corps: "<p>", entetes: { "Content-Type": "text/html" } } },
  );
  assert.equal(refus(await html.requete(wasm, { destination: "" })), "PASSAGE_TYPE_EXECUTABLE");
});

test("hors connexion, un passage reste un échec RÉSEAU : `fetch` lève, ce que la sonde « injoignable » lit (ADR 0046 § 3)", async () => {
  const sw = await installe(FICHIERS);
  sw.reseau.coupe = true;
  const resultat = await sw.requete("/artifacts/application.json", { destination: "" });
  assert.equal(resultat.repondu, true);
  // Une `Response.error()` fait lever `TypeError` à `fetch` côté page ; ce n'est jamais un 503 fabriqué.
  assert.equal(resultat.reponse.type, "error");
  assert.notEqual(resultat.reponse.status, 503);
});

test("la garde n'est pas affaiblie par une destination inconnue : « hors liste » reste refusé", async () => {
  const sw = await installe(FICHIERS);
  const resultat = await sw.requete("/n-importe-quoi", { destination: "inconnue" });
  assert.equal(resultat.reponse.status, 503);
  assert.equal(refus(resultat), "HORS_LISTE");
  assert.equal(ORIGINE.startsWith("https://"), true);
});
