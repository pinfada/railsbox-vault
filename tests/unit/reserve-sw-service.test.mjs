/**
 * Le SERVICE du Service Worker de la coquille (#299, ADR 0048 § 3) : ce qu'il rend d'un fichier listé,
 * et ce qu'il n'invente jamais. Le script éprouvé est celui du PRODUIT, exécuté tel quel dans un `vm`.
 *
 * Gardes éprouvées (numéros de l'annexe A de l'ADR) : 1 (hachage à chaque service), 2 (taille, au
 * service), 15 (en-têtes embarqués), 17 (clé sans chaîne de requête), et la liaison « les octets hachés
 * sont les octets rendus ».
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FICHIERS,
  ORIGINE,
  PROFIL_DE_CODE,
  PROFIL_DE_PAGE,
  installe,
  octets,
  sha256,
  texteDe,
} from "./support-sw-reserve.mjs";

test("un fichier listé est rendu depuis la réserve : mêmes octets, type et en-têtes de son profil", async () => {
  const sw = await installe(FICHIERS);
  sw.appels.length = 0;
  const { repondu, reponse } = await sw.requete("/main.mjs", { destination: "script" });
  assert.equal(repondu, true);
  assert.equal(reponse.status, 200);
  assert.equal(await texteDe(reponse), FICHIERS["/main.mjs"]);
  assert.equal(reponse.headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.equal(reponse.headers.get("Cache-Control"), PROFIL_DE_CODE["Cache-Control"]);
  assert.deepEqual(sw.appels, [], "le service d'un fichier listé ne touche pas le réseau");
});

test("la page d'index est rendue avec CSP, COOP et X-Frame-Options EMBARQUÉS, jamais lus du réseau (garde 15)", async () => {
  // Le réseau « répond » à `/index.html` avec d'autres en-têtes : ils ne doivent pas être repris.
  const sw = await installe(
    FICHIERS,
    {},
    {
      "/index.html": {
        corps: FICHIERS["/index.html"],
        entetes: { "Content-Security-Policy": "default-src *" },
      },
    },
  );
  sw.appels.length = 0;
  for (const chemin of ["/index.html", "/"]) {
    const { reponse } = await sw.requete(chemin, { destination: "document" });
    assert.equal(reponse.status, 200, chemin);
    assert.equal(await texteDe(reponse), FICHIERS["/index.html"]);
    for (const [nom, valeur] of Object.entries(PROFIL_DE_PAGE)) {
      assert.equal(reponse.headers.get(nom), valeur, `${chemin} : ${nom}`);
    }
  }
  assert.deepEqual(sw.appels, [], "aucune requête réseau : les en-têtes viennent de la liste");
});

test("la clé est le CHEMIN EXACT : la chaîne de requête est sans effet, la casse et `//` sont refusés (garde 17)", async () => {
  const sw = await installe(FICHIERS);
  const avecRequete = await sw.requete("/runtime-worker.mjs?use-scheduling-api", {
    destination: "worker",
  });
  assert.equal(
    avecRequete.reponse.status,
    200,
    "le Worker de confiance est créé avec ?use-scheduling-api",
  );
  assert.equal(await texteDe(avecRequete.reponse), FICHIERS["/runtime-worker.mjs"]);
  for (const chemin of ["/MAIN.mjs", "//main.mjs", "/main.mjs/", "/Main.mjs", "/./main.mjs/x"]) {
    sw.appels.length = 0;
    const { reponse } = await sw.requete(chemin, { destination: "script" });
    assert.equal(reponse.status, 503, chemin);
    assert.ok(reponse.headers.get("X-Vault-Refus"), chemin);
    assert.deepEqual(sw.appels, [], `${chemin} : refusé sans toucher le réseau`);
  }
});

test("une entrée altérée DANS le cache est refusée au service, à chaque service (garde 1 : le hachage est recalculé)", async () => {
  const sw = await installe(FICHIERS);
  const cle = `${ORIGINE}/main.mjs`;
  const intact = sw.caches.get(sw.nomDuCache).get(cle);
  // Même taille, un octet retourné : seule l'empreinte le voit.
  const altere = Buffer.from(intact);
  altere[altere.length - 2] ^= 0xff;
  assert.equal(altere.byteLength, intact.byteLength);
  const avant = sw.compteurs.digest;
  assert.equal((await sw.requete("/main.mjs", { destination: "script" })).reponse.status, 200);
  assert.equal(
    sw.compteurs.digest,
    avant + 1,
    "chaque service recalcule le SHA-256 (pas de mémoïsation)",
  );
  sw.caches.get(sw.nomDuCache).set(cle, altere);
  const { reponse } = await sw.requete("/main.mjs", { destination: "script" });
  assert.equal(reponse.status, 503);
  assert.equal(reponse.headers.get("X-Vault-Refus"), "RESERVE_ALTEREE");
  assert.notEqual(
    await texteDe(reponse),
    Buffer.from(altere).toString("utf8"),
    "les octets altérés ne sont jamais rendus",
  );
});

test("une entrée dont la TAILLE diffère est refusée AVANT tout hachage (garde 2 : effet observable, pas présumé équivalent)", async () => {
  const sw = await installe(FICHIERS);
  const cle = `${ORIGINE}/main.mjs`;
  sw.caches
    .get(sw.nomDuCache)
    .set(cle, Buffer.concat([sw.caches.get(sw.nomDuCache).get(cle), octets("!")]));
  const avant = sw.compteurs.digest;
  const { reponse } = await sw.requete("/main.mjs", { destination: "script" });
  assert.equal(reponse.status, 503);
  assert.equal(reponse.headers.get("X-Vault-Refus"), "RESERVE_ALTEREE");
  assert.equal(
    sw.compteurs.digest,
    avant,
    "la taille anormale est refusée sans appel au hachage : le coût est borné",
  );
});

test("une entrée absente du cache est refusée sous RESERVE_INCOMPLETE, sans aller au réseau", async () => {
  const sw = await installe(FICHIERS);
  sw.caches.get(sw.nomDuCache).delete(`${ORIGINE}/main.mjs`);
  sw.appels.length = 0;
  const { reponse } = await sw.requete("/main.mjs", { destination: "script" });
  assert.equal(reponse.status, 503);
  assert.equal(reponse.headers.get("X-Vault-Refus"), "RESERVE_INCOMPLETE");
  assert.deepEqual(sw.appels, []);
});

test("les octets RENDUS sont les octets HACHÉS : une lecture tardive du cache ne les change pas", async () => {
  const sw = await installe(FICHIERS);
  const { reponse } = await sw.requete("/src/coquille/a.mjs", { destination: "script" });
  assert.equal(
    sha256(Buffer.from(await reponse.arrayBuffer())),
    sw.config.liste["/src/coquille/a.mjs"].sha256,
  );
});
