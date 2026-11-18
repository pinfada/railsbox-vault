/**
 * Les MESSAGES du Service Worker de la coquille, la RÉPARATION et le RETRAIT (#299, ADR 0048 §§ 7, 11, 13).
 *
 * Gardes éprouvées : 18 (messages : fenêtres de premier niveau de la coquille seulement, vocabulaire
 * FERMÉ), 29 (retrait : caches d'abord, désinscription ensuite, rien d'autre), 31 (`reparer` ne
 * réécrit rien sans vérifier, n'active rien), et le vocabulaire fermé (`activer`/`skipWaiting` sans réponse).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FICHIERS,
  ORIGINE,
  configurer,
  installe,
  instancier,
  octets,
} from "./support-sw-reserve.mjs";

test("`version` rend l'identité : séquence, plancher, retrait, nombre d'entrées, identité de contenu", async () => {
  const sw = await installe(FICHIERS, { sequence: 12, plancher: 5 });
  const reponse = await sw.message({ type: "version", id: "q1" });
  assert.deepEqual(reponse, {
    id: "q1",
    version: sw.config.identite,
    sequence: 12,
    plancher: 5,
    retrait: false,
    entrees: Object.keys(FICHIERS).length,
  });
});

test("`verifier` nomme les entrées MANQUANTES et ALTÉRÉES, et rend ok sinon", async () => {
  const sw = await installe(FICHIERS);
  assert.equal((await sw.message({ type: "verifier" })).ok, true);
  sw.caches.get(sw.nomDuCache).delete(`${ORIGINE}/main.mjs`);
  const abimee = Buffer.from(sw.caches.get(sw.nomDuCache).get(`${ORIGINE}/src/coquille/a.mjs`));
  abimee[abimee.length - 2] ^= 1;
  sw.caches.get(sw.nomDuCache).set(`${ORIGINE}/src/coquille/a.mjs`, abimee);
  const verdict = await sw.message({ type: "verifier" });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.manquants, ["/main.mjs"]);
  assert.deepEqual(verdict.alteres, ["/src/coquille/a.mjs"]);
});

test("`journal` et `clients` répondent ; le vocabulaire est FERMÉ : `activer`, `skipWaiting` et tout autre type restent sans réponse (garde 18)", async () => {
  const sw = await installe(FICHIERS);
  assert.ok((await sw.message({ type: "journal" })).journal);
  for (const type of ["activer", "skipWaiting", "claim", "supprimer", "", "Version", "VERIFIER"]) {
    assert.equal(await sw.message({ type }), undefined, `« ${type} » ne reçoit aucune réponse`);
  }
  assert.equal(sw.compteurs.skipWaiting, 0);
  assert.equal(sw.compteurs.claim, 0);
});

test("un message mal formé ne reçoit AUCUNE réponse, et il est compté (garde 18)", async () => {
  const sw = await installe(FICHIERS);
  const mauvais = [
    null,
    undefined,
    [],
    ["version"],
    "version",
    42,
    { type: "version", id: "x".repeat(65) },
    { type: "version", id: 7 },
    { type: "version", en: "plus" },
    JSON.parse('{"type":"version","__proto__":{"x":1}}'),
    { type: ["version"] },
  ];
  for (const donnees of mauvais)
    assert.equal(await sw.message(donnees), undefined, JSON.stringify(donnees));
  assert.equal(await sw.message({ type: "version" }, { ports: 0 }), undefined, "sans port : rien");
  assert.equal(await sw.message({ type: "version" }, { ports: 2 }), undefined, "deux ports : rien");
  const journal = (await sw.message({ type: "journal" })).journal;
  assert.ok(journal.messagesRefuses >= mauvais.length, "les refus sont comptés");
  assert.equal((await sw.message({ type: "version", id: "x".repeat(64) })).id, "x".repeat(64));
});

test("seuls les clients de type fenêtre de PREMIER NIVEAU sont écoutés : un Worker, un cadre, une source absente n'obtiennent rien (garde 18)", async () => {
  const sw = await installe(FICHIERS);
  for (const source of [
    { type: "worker", frameType: "none" },
    { type: "sharedworker", frameType: "none" },
    { type: "window", frameType: "nested" },
    { type: "window", frameType: "auxiliary" },
    null,
    undefined,
  ]) {
    assert.equal(
      await sw.message({ type: "version" }, { source }),
      undefined,
      JSON.stringify(source),
    );
  }
  assert.ok(await sw.message({ type: "version" }));
});

function abimee(sw, chemin) {
  const entrees = sw.caches.get(sw.nomDuCache);
  const cle = `${ORIGINE}${chemin}`;
  const copie = Buffer.from(entrees.get(cle));
  copie[0] ^= 1;
  entrees.set(cle, copie);
}

test("`reparer` refait les entrées manquantes ou altérées, chacune écrite APRÈS vérification, sans rien activer (garde 31)", async () => {
  const sw = await installe(FICHIERS);
  sw.caches.get(sw.nomDuCache).delete(`${ORIGINE}/main.mjs`);
  abimee(sw, "/runtime-worker.mjs");
  sw.appels.length = 0;
  sw.operations.length = 0;
  const reponse = await sw.message({ type: "reparer", id: "r" });
  assert.equal(reponse.ok, true);
  assert.deepEqual([...reponse.reparees].sort(), ["/main.mjs", "/runtime-worker.mjs"]);
  assert.deepEqual(
    sw.appels.map((appel) => appel.chemin).sort(),
    ["/main.mjs", "/runtime-worker.mjs"],
    "seules les entrées abîmées sont retéléchargées",
  );
  for (const appel of sw.appels) {
    assert.equal(appel.cache, "no-store");
    assert.equal(appel.redirect, "error");
  }
  assert.equal((await sw.message({ type: "verifier" })).ok, true);
  assert.equal(sw.compteurs.skipWaiting + sw.compteurs.claim, 0, "réparer n'active rien");
});

test("`reparer` N'ÉCRIT PAS une entrée dont les octets ne sont pas ceux de la liste : l'origine hostile n'est pas crue (garde 31)", async () => {
  const sw = await installe(FICHIERS);
  sw.caches.get(sw.nomDuCache).delete(`${ORIGINE}/main.mjs`);
  sw.reseau["/main.mjs"] = { corps: "export const MAIN = 2;\n" }; // même taille, autre empreinte
  sw.operations.length = 0;
  const reponse = await sw.message({ type: "reparer" });
  assert.equal(reponse.ok, false);
  assert.deepEqual(reponse.echecs, ["/main.mjs"]);
  assert.deepEqual(
    sw.operations.filter(([operation]) => operation === "put"),
    [],
    "rien n'a été écrit",
  );
  assert.equal(sw.caches.get(sw.nomDuCache).has(`${ORIGINE}/main.mjs`), false);
  // Une taille différente est refusée de même.
  sw.reseau["/main.mjs"] = { corps: "x" };
  assert.equal((await sw.message({ type: "reparer" })).ok, false);
  assert.deepEqual(
    sw.operations.filter(([operation]) => operation === "put"),
    [],
  );
});

test("`reparer` hors connexion échoue proprement, sans rien écrire ni supprimer", async () => {
  const sw = await installe(FICHIERS);
  sw.caches.get(sw.nomDuCache).delete(`${ORIGINE}/main.mjs`);
  sw.reseau.coupe = true;
  sw.operations.length = 0;
  const reponse = await sw.message({ type: "reparer" });
  assert.equal(reponse.ok, false);
  assert.deepEqual(
    sw.operations.filter(([operation]) => operation === "put" || operation === "delete"),
    [],
  );
});

test("RETRAIT : les caches `reserve-*` d'abord, la désinscription ensuite, puis le message aux clients — et rien d'autre (garde 29)", async () => {
  const config = configurer(FICHIERS, { retrait: true, prefixesAnciens: ["coquille-v1-"] });
  const sw = instancier(config, {
    reseau: {},
    caches: {
      "reserve-abc": {},
      "reserve-def": {},
      "coquille-v1-xyz": {},
      "cache-d-une-autre-inscription": { [`${ORIGINE}/z`]: "z" },
    },
    clients: [{ type: "window", url: `${ORIGINE}/index.html` }],
  });
  assert.equal(await sw.installer(), null);
  await sw.activer();
  assert.deepEqual(
    [...sw.caches.keys()],
    ["cache-d-une-autre-inscription"],
    "un cache d'un autre nom survit",
  );
  const ordre = sw.operations
    .map(([operation]) => operation)
    .filter((o) => o === "delete" || o === "unregister");
  assert.deepEqual(
    ordre,
    ["delete", "delete", "delete", "unregister"],
    "les caches d'abord, la désinscription ensuite",
  );
  assert.equal(sw.compteurs.desinscriptions, 1, "il se désinscrit LUI-MÊME, une seule inscription");
  assert.deepEqual(sw.messagesAuxClients, [{ type: "retire" }]);
});

test("un SW de retrait n'intercepte aucune requête et ne sert rien", async () => {
  const sw = instancier(configurer(FICHIERS, { retrait: true }), {
    reseau: { "/main.mjs": { corps: "x" } },
  });
  await sw.installer();
  assert.equal(
    (await sw.requete("/main.mjs")).repondu,
    false,
    "le SW de retrait laisse passer : il ne fabrique rien",
  );
});

test("un SW de retrait se reconnaît : `version` dit `retrait: true`, et rien n'est jamais vérifié ni servi", async () => {
  const sw = instancier(configurer(FICHIERS, { retrait: true }), { reseau: {} });
  await sw.installer();
  assert.equal((await sw.message({ type: "version" })).retrait, true);
});

test("le script est INDÉPENDANT : aucun `import`, aucune dépendance de module (SW classique, ADR 0048 § 1)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../tools/reserve/sw-coquille.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /importScripts/);
  assert.equal(octets("x").byteLength, 1);
});
